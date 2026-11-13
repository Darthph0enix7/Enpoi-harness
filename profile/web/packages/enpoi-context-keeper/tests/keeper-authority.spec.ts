import { describe, it, expect, beforeEach } from 'vitest'
import {
  activeOperatorMessages,
  assistantPublicText,
  assistantToolCallIds,
  buildActiveAuthorityView,
  classifyUserSource,
  operatorQuoteMatches,
  operatorTextPartsAt,
  userAuthorityLabel,
} from '../src/authority'
import {
  clipUnicodeSafe,
  parseCheckpointDraft,
  renderCheckpointDraft,
  validateCheckpointDraft,
  type CheckpointDraftContext,
} from '../src/checkpoint-draft'
import {
  buildTemplateCheckpoint,
  frameInput,
} from '../src/index'

const HUMAN = { kind: 'user', participant: { kind: 'human', name: 'local' } } as const
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

interface TestEvent {
  type: string
  seq: number
  time: number
  data: unknown
}

function makeSession(events: TestEvent[] = [], meta: { origin?: 'subagent' } = {}) {
  const log = [...events]
  const reads: number[] = []
  const eventReads: number[] = []
  const nodes = log.filter((event) => SURFACE_TYPES.has(event.type)).map((event) => event.seq)
  return {
    id: 'authority-session',
    header: { createdAt: Date.UTC(2026, 10, 13), ...(meta.origin === undefined ? {} : { origin: meta.origin }) },
    get seq() { return log.length },
    events: log,
    reads,
    eventReads,
    snapshotEvents: (from: unknown = 0, to?: number) => {
      const start = Number(from) || 0
      reads.push(start)
      const end = to ?? log.length
      return log.filter((event) => event.seq >= start && event.seq < end)
    },
    eventAt: (seq: number) => {
      eventReads.push(Number(seq))
      return log.find((event) => event.seq === Number(seq))
    },
    surface: { nodes },
    requestContext: () => undefined,
    append: (type: string, data: unknown) => {
      const seq = log.length
      log.push({ type, seq, time: 0, data })
      if (SURFACE_TYPES.has(type)) nodes.push(seq)
      return { type, seq, time: 0, data }
    },
  }
}

let seq = 0
function event(type: string, data: unknown): TestEvent {
  return { type, seq: seq++, time: 0, data }
}
function user(content: unknown, source: unknown): TestEvent {
  return event('user/message', { role: 'user', id: `m${seq}`, content, source })
}
function assistant(content: unknown): TestEvent {
  return event('assistant/message', { turn: 1, step: 1, message: { content } })
}

beforeEach(() => { seq = 0 })

describe('enpoi-context-keeper assistant extraction (public text only)', () => {
  it('keeps public text and public block markers, never reasoning', () => {
    const extracted = assistantPublicText({
      turn: 1,
      step: 1,
      message: {
        content: [
          { type: 'reasoning', text: 'SECRET PRIVATE REASONING' },
          { type: 'text', text: 'public answer' },
          { type: 'image', attachment: { id: 'img' } },
          { type: 'file', attachment: { id: 'file' } },
          { type: 'tool-call', id: 'call', name: 'bash', arguments: '{}' },
        ],
      },
    })
    expect(extracted.text).toBe('public answer')
    expect(extracted.text).not.toContain('SECRET')
    expect(extracted.markers).toEqual(['[image attachment]', '[file attachment]', '[tool call: bash]'])
    expect(extracted.unverifiedLegacy).toBe(false)
  })

  it('labels legacy scalar assistant text as unverified instead of operator text', () => {
    const extracted = assistantPublicText({ turn: 1, step: 1, text: 'legacy landing' })
    expect(extracted.text).toBe('legacy landing')
    expect(extracted.unverifiedLegacy).toBe(true)
  })
})

describe('enpoi-context-keeper source classification', () => {
  it('reserves operator authority for an explicit human participant in a root session', () => {
    expect(classifyUserSource({ kind: 'user' }).authority).toBe('user-unverified')
    expect(classifyUserSource({ kind: 'user' }).authority).not.toBe('operator')
    expect(classifyUserSource(HUMAN).authority).toBe('operator')
    expect(classifyUserSource({ kind: 'user', participant: { kind: 'peer', name: 'agent' } }).authority).toBe('derived-context')
    expect(classifyUserSource({ kind: 'compact-checkpoint', compactionId: 'c1' }).authority).toBe('derived-history')
    expect(classifyUserSource({ kind: 'enpoi-keeper' }).authority).toBe('derived-state')
    expect(classifyUserSource({ kind: 'time-context' }).authority).toBe('derived-context')
    expect(classifyUserSource({ kind: 'compact-checkpoint', participant: { kind: 'human' } }).authority).toBe('derived-history')
    expect(classifyUserSource(undefined).authority).toBe('unattributed')
    expect(userAuthorityLabel('user-unverified')).toBe('USER_ROLE_UNVERIFIED')
    expect(userAuthorityLabel('operator')).toBe('OPERATOR')
  })

  it('never verifies a subagent-parent or peer message from a declared human', () => {
    expect(classifyUserSource({ kind: 'user' }, { subagent: true }).authority).toBe('derived-context')
    expect(classifyUserSource({ kind: 'user', participant: { kind: 'human', name: 'operator' } }, { subagent: true }).authority)
      .toBe('derived-context')
    expect(classifyUserSource({ kind: 'user', participant: { kind: 'peer', name: 'agent' } }, { subagent: true }).authority)
      .toBe('derived-context')
  })
})

describe('enpoi-context-keeper frameInput source attribution', () => {
  it('labels every producer explicitly and never turns a synthetic message into USER', () => {
    seq = 0
    const session = makeSession([
      user('human request', HUMAN),
      user('COMPACTION DERIVED HISTORY', { kind: 'compact-checkpoint', compactionId: 'c1' }),
      user('KEEPER DERIVED STATE', { kind: 'enpoi-keeper' }),
      user('RUNTIME DERIVED CONTEXT', { kind: 'time-context' }),
      assistant([
        { type: 'reasoning', text: 'SECRET REASONING' },
        { type: 'text', text: 'public assistant answer' },
        { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"docs/plan.md"}' },
      ]),
      event('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"path":"docs/plan.md"}' }),
      event('tool/result', { turn: 1, step: 1, message: { toolCallId: 'call-1', content: [{ type: 'text', text: 'tool output' }] } }),
    ])

    const framed = frameInput(session as never, 80, session.seq)
    expect(framed.text).toContain('OPERATOR (human user, seq 0): human request')
    expect(framed.text).toContain('DERIVED_HISTORY (compact-checkpoint')
    expect(framed.text).toContain('DERIVED_STATE (enpoi-keeper')
    expect(framed.text).toContain('DERIVED_CONTEXT (time-context')
    expect(framed.text).toContain('ASSISTANT_PUBLIC (observed public text')
    expect(framed.text).toContain('ASSISTANT_PUBLIC_MARKER')
    expect(framed.text).toContain('[tool call: read]')
    expect(framed.text).toContain('OBSERVED FILES IN WINDOW')
    expect(framed.text).toContain('TOOL_RESULT (observed output, not verified execution')
    expect(framed.text).not.toContain('USER:')
    expect(framed.text).not.toContain('SECRET REASONING')
    expect(framed.operatorMessages.get(0)).toEqual(['human request'])
    expect(framed.operatorMessages.has(1)).toBe(false)
  })

  it('carries the prior derived snapshot as context and states a partial-window gap', () => {
    seq = 0
    const events: TestEvent[] = [
      event('state/checkpoint', { text: 'PRIOR OPERATOR GOAL ANCHOR', version: 1, basedOnSeq: 0, basedOnStructuralCount: 0, model: 'm', via: 'llm', telemetry: 't', createdAt: 0 }),
      user('older request', HUMAN),
      user('mid request', HUMAN),
      user('new request', HUMAN),
      user('PRIOR KEEPER SNAPSHOT', { kind: 'enpoi-keeper' }),
    ]
    const session = makeSession(events)
    const framed = frameInput(session as never, 2, session.seq)
    expect(framed.partial).toBe(true)
    expect(framed.text).toContain('PRIOR DERIVED STATE')
    expect(framed.text).toContain('PRIOR KEEPER SNAPSHOT')
    expect(framed.text).not.toContain('PRIOR OPERATOR GOAL ANCHOR')
    expect(framed.text).toContain('WINDOW GAP')
    expect(framed.text).toContain('new request')
    expect(framed.text).not.toContain('older request')
  })
})

describe('enpoi-context-keeper deterministic template authority', () => {
  it('quotes only the human operator and keeps reasoning and derived-state prose out', () => {
    seq = 0
    const session = makeSession([
      user('REAL OPERATOR GOAL', HUMAN),
      user('STANDING DIRECTIVE FROM COMPACTION', { kind: 'compact-checkpoint', compactionId: 'c1' }),
      user('KEEPER STATE PROSE', { kind: 'enpoi-keeper' }),
      assistant([
        { type: 'reasoning', text: 'SECRET REASONING' },
        { type: 'text', text: 'public answer' },
        { type: 'tool-call', id: 'call-1', name: 'write', arguments: '{"path":"docs/plan.md"}' },
      ]),
      event('assistant/message', { turn: 1, step: 2, text: 'legacy answer' }),
      event('tool/call', { turn: 1, step: 2, callId: 'call-1', name: 'write', arguments: '{"path":"docs/plan.md"}' }),
      event('tool/result', { turn: 1, step: 2, message: { toolCallId: 'call-1', content: [] }, error: { message: 'write failed' } }),
    ])
    const text = buildTemplateCheckpoint(session as never)
    expect(text).toContain('CURRENT OPERATOR REQUEST')
    expect(text).toContain('REAL OPERATOR GOAL')
    expect(text).not.toContain('STANDING DIRECTIVE FROM COMPACTION')
    expect(text).not.toContain('KEEPER STATE PROSE')
    expect(text).not.toContain('SECRET REASONING')
    expect(text).toContain('Unverified legacy assistant text')
    expect(text).toContain('legacy answer')
    expect(text).toContain('docs/plan.md')
    expect(text).toContain('write failed')
  })

  it('keeps a legacy bare user-role request visible with an unverified label', () => {
    seq = 0
    const session = makeSession([
      user('LEGACY BARE REQUEST', { kind: 'user' }),
      assistant([{ type: 'text', text: 'public answer' }]),
    ])
    const text = buildTemplateCheckpoint(session as never)
    expect(text).toContain('CURRENT USER-ROLE REQUEST (actor unverified; public request, not operator authority)')
    expect(text).toContain('LEGACY BARE REQUEST')
    expect(text).not.toContain('CURRENT OPERATOR REQUEST')
  })

  it('takes public assistant text while omitting a reasoning block from the same message', () => {
    seq = 0
    const session = makeSession([
      user('REAL OPERATOR GOAL', HUMAN),
      assistant([
        { type: 'reasoning', text: 'SECRET REASONING' },
        { type: 'text', text: 'public assistant answer' },
      ]),
    ])
    const text = buildTemplateCheckpoint(session as never)
    expect(text).toContain('public assistant answer')
    expect(text).not.toContain('SECRET REASONING')
  })
})

describe('enpoi-context-keeper checkpoint draft validation', () => {
  function contextFor(session: ReturnType<typeof makeSession>, snapshotSeq = session.seq, windowStartSeq = 0): CheckpointDraftContext {
    return {
      snapshotSeq,
      windowStartSeq,
      active: buildActiveAuthorityView(session as never),
    }
  }

  function contractSession(): ReturnType<typeof makeSession> {
    seq = 0
    return makeSession([
      user('Please ship the keeper.\nKeep the operator quote byte-for-byte: "tool_call" and JSON field reasoning.', HUMAN),
      assistant([
        { type: 'text', text: 'The assistant proposed a design.' },
      ]),
      event('tool/result', { turn: 1, step: 1, message: { toolCallId: 'call-1', content: [{ type: 'text', text: 'observed output' }] } }),
    ])
  }

  it('renders exact operator quote labels and observed anchors without claiming acceptance', () => {
    const session = contractSession()
    const quote = 'Please ship the keeper.\nKeep the operator quote byte-for-byte: "tool_call" and JSON field reasoning.'
    const draft = parseCheckpointDraft(JSON.stringify({
      items: [
        { kind: 'operator_goal', text: 'ship the keeper', quote, sourceSeq: 0 },
        { kind: 'accepted_decision', text: 'keep the JSON field reasoning', quote, sourceSeq: 0 },
        { kind: 'observed_evidence', text: 'assistant proposal observed', sourceSeq: 1 },
        { kind: 'unresolved_work', text: 'inspect the tool output', sourceSeq: 2 },
      ],
    }))
    expect(draft).not.toBeNull()
    const validation = validateCheckpointDraft(draft!, contextFor(session))
    expect(validation.ok).toBe(true)
    const text = renderCheckpointDraft(validation.items, { maxChars: 2400, windowStartSeq: 0 })
    expect(text).toContain('🎯 OPERATOR GOALS (exact operator quote; interpretation unconfirmed):')
    expect(text).toContain('✅ OPERATOR QUOTE (interpretation unconfirmed; not proof of an accepted decision')
    expect(text).toContain('operator quote (interpretation unconfirmed), seq 0:')
    expect(text).toContain('👁 OBSERVED EVIDENCE')
    expect(text).toContain('⚡ OPEN WORK & NEXT STEP')
    expect(text).toContain('tool_call')
    expect(text).toContain('JSON field reasoning')
    expect(text).toContain('not verified execution')
    expect(text).toContain('public assistant text')
    // The exact original request bytes survive inside the quote.
    expect(text).toContain('byte-for-byte')
  })

  it('ignores a model `decided` flag: an assistant proposal still needs operator evidence', () => {
    const session = contractSession()
    const validation = validateCheckpointDraft({
      items: [{ kind: 'accepted_decision', text: 'accepted by model fiat', quote: 'The assistant proposed a design.', sourceSeq: 1, decided: true }],
    }, contextFor(session))
    expect(validation.ok).toBe(false)
  })

  it('rejects invalid JSON and non-exact or wrong-source quotes', () => {
    const session = contractSession()
    expect(parseCheckpointDraft('not json')).toBeNull()
    const wrongQuote = validateCheckpointDraft({
      items: [{ kind: 'operator_goal', text: 'goal', quote: 'not in the operator message', sourceSeq: 0 }],
    }, contextFor(session))
    expect(wrongQuote.ok).toBe(false)

    const assistantSource = validateCheckpointDraft({
      items: [{ kind: 'accepted_decision', text: 'proposal is a decision', quote: 'The assistant proposed a design.', sourceSeq: 1 }],
    }, contextFor(session))
    expect(assistantSource.ok).toBe(false)

    const derivedSource = validateCheckpointDraft({
      items: [{ kind: 'operator_goal', text: 'derived prose', quote: 'derived', sourceSeq: 2 }],
    }, contextFor(session))
    expect(derivedSource.ok).toBe(false)
  })

  it('rejects future and unlogged anchors', () => {
    const session = contractSession()
    const future = validateCheckpointDraft({
      items: [{ kind: 'observed_evidence', text: 'future', sourceSeq: session.seq }],
    }, contextFor(session))
    expect(future.ok).toBe(false)
    expect(future.reason).toContain('future')

    const unlogged = validateCheckpointDraft({
      items: [{ kind: 'observed_evidence', text: 'missing', sourceSeq: 99 }],
    }, contextFor(session, 100))
    expect(unlogged.ok).toBe(false)
    expect(unlogged.reason).toContain('unlogged')
  })

  it('accepts an older verified operator anchor outside the window and states the gap', () => {
    const session = contractSession()
    const validation = validateCheckpointDraft({
      items: [{ kind: 'operator_goal', text: 'older goal', quote: 'Please ship the keeper.', sourceSeq: 0 }],
    }, contextFor(session, session.seq, 2))
    expect(validation.ok).toBe(true)
    const text = renderCheckpointDraft(validation.items, { maxChars: 2400, windowStartSeq: 2 })
    expect(text).toContain('outside the current input window')
    expect(text).toContain('_Input window starts at seq 2')
  })

  it('preserves non-code English/German/Turkish text and literal tool_call JSON', () => {
    const session = contractSession()
    const draft = parseCheckpointDraft(JSON.stringify({
      items: [
        { kind: 'operator_goal', text: 'keep en/de/tr: detail, Übersicht, ayrıntı', quote: 'Please ship the keeper.', sourceSeq: 0 },
        { kind: 'observed_evidence', text: '{"reasoning":"legitimate code field","tool_call":"literal"}', sourceSeq: 1 },
      ],
    }))
    const validation = validateCheckpointDraft(draft!, contextFor(session))
    expect(validation.ok).toBe(true)
    const text = renderCheckpointDraft(validation.items, { maxChars: 2400, windowStartSeq: 0 })
    expect(text).toContain('detail, Übersicht, ayrıntı')
    expect(text).toContain('"reasoning":"legitimate code field"')
    expect(text).toContain('"tool_call":"literal"')
  })
})

describe('enpoi-context-keeper exact operator quote verification', () => {
  it('accepts a complete block or complete line run, including one-character lines', () => {
    expect(operatorQuoteMatches(['deploy everything now'], 'deploy everything now')).toBe(true)
    expect(operatorQuoteMatches(['deploy everything now'], 'deploy')).toBe(false)
    expect(operatorQuoteMatches(['deploy everything now'], 'e')).toBe(false)
    expect(operatorQuoteMatches(['Go'], 'Go')).toBe(true)
    expect(operatorQuoteMatches(['e'], 'e')).toBe(true)
    expect(operatorQuoteMatches(['line1\nline2'], 'line1')).toBe(true)
    expect(operatorQuoteMatches(['line1\nline2'], 'line1\nline2')).toBe(true)
    expect(operatorQuoteMatches(['line1\nline2'], 'line1\nline')).toBe(false)
    expect(operatorQuoteMatches(['deploy now'], ' now')).toBe(false)
    expect(operatorQuoteMatches(['   '], '   ')).toBe(false)
    expect(operatorQuoteMatches([], 'anything')).toBe(false)
  })

  it('never joins separate text blocks into a manufactured quote', () => {
    expect(operatorQuoteMatches(['line1', 'line2'], 'line1\nline2')).toBe(false)
    expect(operatorQuoteMatches(['line1', 'line2'], 'line2')).toBe(true)
  })
})

describe('enpoi-context-keeper active surface authority view', () => {
  function activeSession() {
    seq = 0
    const session = makeSession([
      user('deploy now', HUMAN), // 0
      user('old human without actor', { kind: 'user' }), // 1
      assistant([
        { type: 'tool-call', id: 'call-a', name: 'bash', arguments: '{}' },
        { type: 'text', text: 'public assistant text' },
      ]), // 2
      event('tool/call', { turn: 1, step: 1, callId: 'call-a', name: 'bash', arguments: '{}' }), // 3
      event('tool/call', { turn: 1, step: 1, callId: 'call-abandoned', name: 'bash', arguments: '{}' }), // 4
      event('tool/result', { turn: 1, step: 1, message: { toolCallId: 'call-a', content: [{ type: 'text', text: 'ok' }] } }), // 5
      event('tool/result', { turn: 1, step: 1, message: { toolCallId: 'call-abandoned', content: [] } }), // 6
      event('state/checkpoint', { text: 'OLD CHECKPOINT', version: 1 }), // 7
      event('state/checkpoint', { text: 'LATEST CHECKPOINT', version: 2 }), // 8
      user('abandoned branch request', HUMAN), // 9
    ])
    // Current model-visible branch: the human request, the unverified
    // user-role message, the assistant call, and its active result. The
    // abandoned call/result and abandoned user message remain only in the log.
    session.surface.nodes.length = 0
    session.surface.nodes.push(0, 1, 2, 5)
    return session
  }

  it('exposes only current surface users/operators and pairs raw tool calls', () => {
    const session = activeSession()
    const view = buildActiveAuthorityView(session as never)

    expect(view.activeSeqs).toEqual([0, 1, 2, 5])
    expect(view.firstUser?.seq).toBe(0)
    expect(view.lastUser?.seq).toBe(1)
    expect(view.lastUser?.authority).toBe('user-unverified')
    expect(view.lastUser?.parts).toEqual(['old human without actor'])
    expect(view.lastUser?.display).toBe('old human without actor')
    expect(view.firstOperator?.seq).toBe(0)
    expect(view.lastOperator?.seq).toBe(0)
    expect(view.operatorPartsAt(0)).toEqual(['deploy now'])
    expect(view.operatorPartsAt(1)).toBeNull()
    expect(view.operatorPartsAt(9)).toBeNull()
    expect(operatorTextPartsAt(session as never, 0, view)).toEqual(['deploy now'])
    expect(operatorTextPartsAt(session as never, 1, view)).toBeNull()

    expect(view.eventAt(3)?.type).toBe('tool/call')
    expect(view.eventAt(4)).toBeUndefined()
    expect(view.eventAt(5)?.type).toBe('tool/result')
    expect(view.eventAt(6)).toBeUndefined()
    expect(view.eventAt(7)).toBeUndefined()
    expect(view.eventAt(8)?.type).toBe('state/checkpoint')
    expect(view.eventAt(9)).toBeUndefined()
    expect(view.isActive(8)).toBe(true)
    expect(view.isActive(7)).toBe(false)
    expect(view.toolResultSeq('call-a')).toBe(5)
    expect(view.toolResultSeq('call-abandoned')).toBeUndefined()
    expect(assistantToolCallIds(session.events[2]!.data)).toEqual(['call-a'])
    expect(assistantToolCallIds({ message: { content: [{ type: 'tool_call', callId: 'unknown-spelling' }] } })).toEqual([])

    const windowOperators = activeOperatorMessages(view, [0, 1, 9])
    expect([...windowOperators.keys()]).toEqual([0])
    expect(windowOperators.get(0)).toEqual(['deploy now'])

    const snapshotView = buildActiveAuthorityView(session as never, 3)
    expect(snapshotView.activeSeqs).toEqual([0, 1, 2])
    expect(snapshotView.eventAt(5)).toBeUndefined()
    expect(snapshotView.lastUser?.seq).toBe(1)
  })

  it('rejects abandoned anchors, substrings, and unverified user-role authority', () => {
    const session = activeSession()
    const context: CheckpointDraftContext = {
      snapshotSeq: 10,
      windowStartSeq: 3,
      active: buildActiveAuthorityView(session as never),
    }
    const validate = (item: Record<string, unknown>) => validateCheckpointDraft({ items: [item] }, context)

    expect(validate({ kind: 'operator_goal', text: 'ship', quote: 'deploy now', sourceSeq: 0 }).ok).toBe(true)
    expect(validate({ kind: 'operator_goal', text: 'ship', quote: 'deploy', sourceSeq: 0 }).ok).toBe(false)
    expect(validate({ kind: 'operator_goal', text: 'old', quote: 'old human without actor', sourceSeq: 1 }).ok).toBe(false)
    expect(validate({ kind: 'operator_goal', text: 'abandoned', quote: 'abandoned branch request', sourceSeq: 9 }).ok).toBe(false)
    expect(validate({ kind: 'observed_evidence', text: 'paired call', sourceSeq: 3 }).ok).toBe(true)
    expect(validate({ kind: 'observed_evidence', text: 'abandoned call', sourceSeq: 4 }).ok).toBe(false)
    expect(validate({ kind: 'observed_evidence', text: 'active result', sourceSeq: 5 }).ok).toBe(true)
    expect(validate({ kind: 'observed_evidence', text: 'abandoned result', sourceSeq: 6 }).ok).toBe(false)
    expect(validate({ kind: 'observed_evidence', text: 'old checkpoint', sourceSeq: 7 }).ok).toBe(false)
    expect(validate({ kind: 'observed_evidence', text: 'latest checkpoint', sourceSeq: 8 }).ok).toBe(false)
  })
})

describe('enpoi-context-keeper safe clip and complete-item renderer', () => {
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
  const item = (text: string, quote = 'Go', sourceSeq = 1): {
    kind: 'operator_goal'
    text: string
    sourceSeq: number
    quote: string
    outsideWindow: boolean
    anchorType: string
  } => ({ kind: 'operator_goal', text, sourceSeq, quote, outsideWindow: false, anchorType: 'user/message' })

  it('clips by code point without splitting a surrogate pair', () => {
    expect(clipUnicodeSafe('abc😀def', 4)).toBe('abc')
    expect(clipUnicodeSafe('😀x', 1)).toBe('')
    expect(clipUnicodeSafe('😀x', 2)).toBe('😀')
    expect(clipUnicodeSafe('abc', 2, '…')).toBe('a…')
    const clipped = clipUnicodeSafe(`${'a'.repeat(10)}😀tail`, 11)
    expect(clipped.length).toBeLessThanOrEqual(11)
    expect(LONE_SURROGATE.test(clipped)).toBe(false)
  })

  it('drops whole trailing items instead of chopping attribution or source refs', () => {
    const first = item('first complete goal')
    const second = item('second complete goal')
    const one = renderCheckpointDraft([first], { maxChars: 10_000, windowStartSeq: 0 })
    const two = renderCheckpointDraft([first, second], { maxChars: 10_000, windowStartSeq: 0 })
    const cap = one.length + 2
    expect(two.length).toBeGreaterThan(cap)

    const text = renderCheckpointDraft([first, second], { maxChars: cap, windowStartSeq: 0 })
    expect(text.length).toBeLessThanOrEqual(cap)
    expect(text).toContain('first complete goal')
    expect(text).toContain('operator quote (interpretation unconfirmed), seq 1: "Go"')
    expect(text).not.toContain('second complete goal')
    expect(text).toContain('…')
    expect(LONE_SURROGATE.test(text)).toBe(false)
  })

  it('returns empty for no complete item fit and preserves emoji in retained items', () => {
    expect(renderCheckpointDraft([item('x'.repeat(5000))], { maxChars: 300, windowStartSeq: 0 })).toBe('')
    const emoji = renderCheckpointDraft([item('😀 complete goal')], { maxChars: 2400, windowStartSeq: 0 })
    expect(emoji).toContain('😀 complete goal')
    expect(LONE_SURROGATE.test(emoji)).toBe(false)
  })
})
