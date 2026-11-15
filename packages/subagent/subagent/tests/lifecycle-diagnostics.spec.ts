import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  SessionId,
  SessionLogOffset,
  SessionSeq,
  type SessionEvent,
  type SessionEventMap,
  type SessionEventType,
} from '@deepseek-ai/dsh-session'
import { createSettlementMessage } from '../src/continuation-messages.ts'
import { createActivationObserver, type LifecycleEmitter } from '../src/lifecycle.ts'

const CHILD = SessionId('diagnostic-child')

const SURFACE_TYPES = new Set<SessionEventType>(['user/message', 'assistant/message', 'tool/result'])

/** Build one typed log event; only surface events carry a surface operation. */
function event<T extends SessionEventType>(
  type: T,
  seq: number,
  data: SessionEventMap[T],
): SessionEvent<T> {
  return {
    type,
    seq: SessionSeq(seq),
    time: 0,
    data,
    ...SURFACE_TYPES.has(type) ? { surfaceOp: 'append' as const } : {},
  } as SessionEvent<T>
}

/** Build the minimal Agent surface the observer reads. */
function childOf(events: readonly SessionEvent[]): Agent {
  return {
    session: {
      seq: SessionLogOffset(events.length),
      snapshotEvents: () => events,
    },
  } as Agent
}

/** Run start/capture for one epoch and return its terminal facts. */
function terminalOf(events: readonly SessionEvent[]) {
  const emitted: string[] = []
  const emit: LifecycleEmitter = (name) => { emitted.push(name) }
  const observer = createActivationObserver(emit, 'spawn', CHILD, {} as Agent)
  const child = childOf(events)
  observer.start(child)
  observer.capture(child)
  return {
    observer,
    child,
    emitted,
    terminal: observer.terminal(undefined),
    emitTerminal: (failure?: unknown) => { observer.settle(failure) },
  }
}

const userPrompt = event('user/message', 0, {
  id: MessageId('asked-turn'),
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text: 'review this' }],
})

function stepStart(seq: number): SessionEvent<'step/start'> {
  return event('step/start', seq, { turn: 1, step: 1 })
}

function assistantText(seq: number, text: string): SessionEvent<'assistant/message'> {
  return event('assistant/message', seq, {
    turn: 1,
    step: 1,
    message: {
      id: MessageId(`assistant-${seq}`),
      role: 'assistant',
      source: { kind: 'model', provider: 'test', model: 'test' },
      content: [{ type: 'text', text }],
    },
    stream: [],
  })
}

function assistantReasoning(seq: number): SessionEvent<'assistant/message'> {
  return event('assistant/message', seq, {
    turn: 1,
    step: 1,
    message: {
      id: MessageId(`assistant-${seq}`),
      role: 'assistant',
      source: { kind: 'model', provider: 'test', model: 'test' },
      content: [{ type: 'reasoning', text: 'private deliberation' }],
    },
    stream: [],
  })
}

function toolResult(seq: number, isError: boolean): SessionEvent<'tool/result'> {
  return event('tool/result', seq, {
    turn: 1,
    step: 1,
    message: {
      id: MessageId(`tool-${seq}`),
      role: 'tool',
      source: { kind: 'tool', callId: ToolCallId('call-1') },
      toolCallId: ToolCallId('call-1'),
      content: [{ type: 'text', text: isError ? 'failed' : 'ok' }],
      isError,
    },
    ...isError ? { error: { name: 'Error', code: 'TOOL_FAILED' } } : {},
  })
}

function turnEnd(seq: number, reason: SessionEventMap['turn/end']['reason']): SessionEvent<'turn/end'> {
  return event('turn/end', seq, { turn: 1, reason })
}

describe('activation terminal diagnostics', () => {
  it('carries a provider failure code, successful tool evidence, and the last public text', () => {
    const events = [
      userPrompt,
      stepStart(1),
      assistantText(2, 'I checked the builder.'),
      toolResult(3, false),
      assistantReasoning(4),
      turnEnd(5, { kind: 'error', error: { message: 'boom', code: 'PROVIDER_TIMEOUT' } }),
    ]
    const { terminal } = terminalOf(events)

    expect(terminal.stopReason).toBe('error')
    expect(terminal.failure).toEqual({ code: 'PROVIDER_TIMEOUT' })
    expect(terminal.lastSuccessfulOperation).toEqual({ seq: SessionSeq(3) })
    expect(terminal.lastPublicText).toBe('I checked the builder.')

    const notice = createSettlementMessage(CHILD, terminal)
    expect(notice.content[0]).toEqual({
      type: 'text',
      text: `Background subagent ${CHILD} failed before it finished (code: PROVIDER_TIMEOUT) — `
        + `inspect its session ${CHILD} or continue it with a follow-up.`,
    })
    expect(notice.content).toContainEqual({
      type: 'text',
      text: 'Diagnostic: code=PROVIDER_TIMEOUT; recoverability=unknown; '
        + 'last successful tool result at event seq 3.',
    })
  })

  it('ignores a failed tool result when naming the last successful operation', () => {
    const events = [
      userPrompt,
      stepStart(1),
      toolResult(2, false),
      toolResult(3, true),
      turnEnd(4, { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } }),
    ]
    expect(terminalOf(events).terminal.lastSuccessfulOperation).toEqual({ seq: SessionSeq(2) })
  })

  it('names a pre-step rejection as not recoverable', () => {
    const events = [userPrompt, stepStart(1), turnEnd(2, { kind: 'blocked' })]
    expect(terminalOf(events).terminal.failure).toEqual({ code: 'TURN_BLOCKED', recoverable: false })
    expect(terminalOf(events).terminal.stopReason).toBe('refusal')
  })

  it('names accepted work cancelled before any turn as not recoverable', () => {
    const events = [
      userPrompt,
      event('agent/inbox/spliced', 1, {
        target: 'next-turn',
        start: 0,
        removedCount: 1,
        inserted: [],
        outcome: 'canceled',
      }),
    ]
    expect(terminalOf(events).terminal.failure).toEqual({ code: 'WORK_DROPPED_UNRUN', recoverable: false })
    expect(terminalOf(events).terminal.stopReason).toBe('aborted')
  })

  it.each([
    ['aborted without a provider failure', { kind: 'aborted', reason: { kind: 'user' } } as const, 'TURN_ABORTED'],
    ['aborted with a provider failure', {
      kind: 'aborted',
      reason: { kind: 'user' },
      error: { message: 'dropped', code: 'TRANSPORT' },
    } as const, 'TRANSPORT'],
    ['max tokens', { kind: 'max-tokens' } as const, 'OUTPUT_TOKEN_LIMIT'],
    ['interrupted', { kind: 'interrupted' } as const, 'TURN_INTERRUPTED'],
  ])('names %s with a stable code', (_label, reason, code) => {
    expect(terminalOf([userPrompt, stepStart(1), turnEnd(2, reason)]).terminal.failure).toEqual({ code })
  })

  it('never reports a completed epoch as a failure', () => {
    const { terminal } = terminalOf([userPrompt, stepStart(1), assistantText(2, 'done'), turnEnd(3, { kind: 'completed' })])
    expect(terminal.failure).toBeUndefined()
    expect(terminal.stopReason).toBe('completed')
    const notice = createSettlementMessage(CHILD, terminal)
    expect(notice.content.some(block => block.type === 'text' && block.text.startsWith('Diagnostic:'))).toBe(false)
  })

  it('withholds teardown-failed output but preserves the public diagnostic evidence', () => {
    const events = [userPrompt, stepStart(1), assistantText(2, 'the answer'), turnEnd(3, { kind: 'completed' })]
    const { observer, emitTerminal } = terminalOf(events)
    const terminal = observer.terminal(new Error('scope unwind failed'))

    expect(terminal.stopReason).toBe('error')
    expect(terminal.failure).toEqual({ code: 'TEARDOWN_FAILED' })
    expect(terminal.output).toBeUndefined()
    expect(terminal.lastPublicText).toBe('the answer')

    const notice = createSettlementMessage(CHILD, terminal)
    expect(notice.content).toContainEqual({
      type: 'text',
      text: 'Last public text before the ending (unverified):',
    })
    expect(notice.content).toContainEqual({ type: 'text', text: 'the answer' })

    emitTerminal(new Error('scope unwind failed'))
    // The terminal edge and the notice derive from the same one computation.
    expect(observer.terminal(new Error('scope unwind failed'))).toEqual(terminal)
  })

  it('keeps a completed epoch with no accounting turn free of a failure', () => {
    const { terminal } = terminalOf([userPrompt])
    expect(terminal.stopReason).toBe('completed')
    expect(terminal.failure).toBeUndefined()
  })

  it('names an empty recorded provider code as UNKNOWN', () => {
    const error = terminalOf([
      userPrompt,
      stepStart(1),
      turnEnd(2, { kind: 'error', error: { message: '', code: '' } }),
    ]).terminal
    expect(error.failure).toEqual({ code: 'UNKNOWN' })

    const aborted = terminalOf([
      userPrompt,
      stepStart(1),
      turnEnd(2, { kind: 'aborted', reason: { kind: 'user' }, error: { message: '', code: '' } }),
    ]).terminal
    expect(aborted.failure).toEqual({ code: 'UNKNOWN' })
  })

  it('keeps a completed turn followed by cancelled unrun work as a failure', () => {
    const events = [
      userPrompt,
      stepStart(1),
      turnEnd(2, { kind: 'completed' }),
      event('agent/inbox/spliced', 3, {
        target: 'next-turn',
        start: 0,
        removedCount: 1,
        inserted: [],
        outcome: 'canceled',
      }),
    ]
    expect(terminalOf(events).terminal.failure).toEqual({ code: 'WORK_DROPPED_UNRUN', recoverable: false })
    expect(terminalOf(events).terminal.stopReason).toBe('aborted')
  })

  it('preserves teardown evidence even when the last public text is absent', () => {
    const events = [userPrompt, stepStart(1), toolResult(2, false), turnEnd(3, { kind: 'completed' })]
    const { observer } = terminalOf(events)
    const terminal = observer.terminal(new Error('scope unwind failed'))
    expect(terminal.failure).toEqual({ code: 'TEARDOWN_FAILED' })
    expect(terminal.lastSuccessfulOperation).toEqual({ seq: SessionSeq(2) })
    expect(terminal.lastPublicText).toBeUndefined()
  })

  it('keeps reasoning-only epochs from supplying public text', () => {
    const events = [userPrompt, stepStart(1), assistantReasoning(2), turnEnd(3, { kind: 'error', error: { message: 'x', code: 'E' } })]
    expect(terminalOf(events).terminal.lastPublicText).toBeUndefined()
  })
})
