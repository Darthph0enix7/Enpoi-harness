import { describe, expect, it } from 'vitest'
import { ToolCallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import {
  interruptedTurnClosers,
  Session,
  SessionId,
  TOOL_NOT_STARTED,
  TOOL_OUTCOME_UNKNOWN,
} from '../src/index.ts'
import { unansweredToolCalls } from '../src/repair.ts'

/**
 * Live in-turn repair: a step that reaches its boundary with an assistant tool
 * call it never answered gains one synthetic result before `step/end`, in the
 * exact shape crash recovery writes. The repair is idempotent, and a reload of
 * the already-repaired log never duplicates it.
 */

function assistantCalls(...ids: string[]) {
  return createAssistantMessage({
    content: ids.map(id => ({
      type: 'tool-call' as const,
      id: ToolCallId(id),
      name: 'echo',
      arguments: '{}',
    })),
    source: { provider: 'mock', model: 'mock' },
  })
}

/** An open turn 1 / step 1 whose assistant message requests `calls`, with `started` calls begun and `answered` results recorded. */
function openStep(options: {
  calls: string[]
  started?: string[]
  answered?: string[]
}): { session: Session; callSeqs: Map<string, number> } {
  const session = Session.create(SessionId(`live-repair-${options.calls.join('-')}-${options.answered?.join('-') ?? 'none'}`))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: assistantCalls(...options.calls),
  }, { surfaceOp: 'append' })
  const callSeqs = new Map<string, number>()
  for (const id of options.started ?? []) {
    callSeqs.set(id, session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: ToolCallId(id),
      name: 'echo',
      arguments: '{}',
    }).seq)
  }
  for (const id of options.answered ?? []) {
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId(id),
        content: [{ type: 'text', text: `${id} ok` }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
  }
  return { session, callSeqs }
}

function resultEvents(session: Session) {
  return session.snapshotEvents().filter(event => event.type === 'tool/result')
}

describe('Session.closeUnansweredToolCalls', () => {
  it('appends exactly one synthetic result for the call left without one', () => {
    const { session, callSeqs } = openStep({
      calls: ['c1', 'c2'],
      started: ['c1', 'c2'],
      answered: ['c1'],
    })
    const before = session.snapshotEvents().length

    expect(session.closeUnansweredToolCalls(1, 1)).toBe(1)

    const events = session.snapshotEvents()
    expect(events).toHaveLength(before + 1)
    const appended = events.at(-1)!
    expect(appended.type).toBe('tool/result')
    if (appended.type !== 'tool/result') throw new Error('expected a tool/result')
    expect(appended.data).toMatchObject({
      turn: 1,
      step: 1,
      message: {
        id: `interrupted-tool-result-c2-${appended.seq}`,
        role: 'tool',
        toolCallId: ToolCallId('c2'),
        isError: true,
        source: { kind: 'tool', callId: ToolCallId('c2') },
      },
      error: { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN },
    })
    expect(appended.surfaceOp).toBe('append')
    expect(appended.sourceEventSeqs).toEqual([callSeqs.get('c2')])
    // The next request shows both results in call order.
    expect(session.deriveMessages().flatMap(message =>
      message.role === 'tool' ? [message.toolCallId] : [])).toEqual(['c1', 'c2'])
  })

  it('marks a call whose start was never recorded with TOOL_NOT_STARTED', () => {
    const { session } = openStep({ calls: ['c1'], answered: [] })

    expect(session.closeUnansweredToolCalls(1, 1)).toBe(1)

    const appended = session.snapshotEvents().at(-1)!
    if (appended.type !== 'tool/result') throw new Error('expected a tool/result')
    expect(appended.data.error).toEqual({
      name: 'ToolNotStartedError',
      code: TOOL_NOT_STARTED,
    })
    // No start was recorded, so the result cites no `tool/call`.
    expect(appended.sourceEventSeqs).toBeUndefined()
    expect(appended.data.message.content).toEqual([{
      type: 'text',
      text: 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.',
    }])
  })

  it('is idempotent: a second close appends nothing', () => {
    const { session } = openStep({
      calls: ['c1', 'c2'],
      started: ['c1', 'c2'],
      answered: ['c1'],
    })
    expect(session.closeUnansweredToolCalls(1, 1)).toBe(1)
    const afterFirst = session.snapshotEvents()

    expect(session.closeUnansweredToolCalls(1, 1)).toBe(0)
    expect(session.snapshotEvents()).toHaveLength(afterFirst.length)
    expect(resultEvents(session)).toHaveLength(2)
  })

  it('appends nothing for a completed batch', () => {
    const { session } = openStep({
      calls: ['c1', 'c2'],
      started: ['c1', 'c2'],
      answered: ['c1', 'c2'],
    })
    const before = session.snapshotEvents()

    expect(session.closeUnansweredToolCalls(1, 1)).toBe(0)
    expect(session.snapshotEvents()).toHaveLength(before.length)
    expect(resultEvents(session)).toHaveLength(2)
  })

  it('leaves a closed earlier turn and a different step untouched', () => {
    const { session } = openStep({
      calls: ['old'],
      started: ['old'],
      answered: [],
    })
    // Close turn 1's step without repairing it, then open a new turn whose own
    // call is the only one the new step may answer.
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })
    session.append('assistant/message', {
      turn: 2,
      step: 1,
      stream: [],
      message: assistantCalls('fresh'),
    }, { surfaceOp: 'append' })

    expect(unansweredToolCalls(session.snapshotEvents(), 2, 1).map(call => call.callId))
      .toEqual([ToolCallId('fresh')])
    expect(session.closeUnansweredToolCalls(2, 1)).toBe(1)
    const results = resultEvents(session)
    expect(results).toHaveLength(1)
    const only = results[0]!
    expect(only.type === 'tool/result' && only.data.message.toolCallId).toBe('fresh')
  })
})

describe('crash recovery over a live-repaired log', () => {
  it('does not duplicate the synthetic result when the turn already ended', () => {
    const { session } = openStep({
      calls: ['c1', 'c2'],
      started: ['c1'],
      answered: ['c1'],
    })
    expect(session.closeUnansweredToolCalls(1, 1)).toBe(1)
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } } })

    expect(interruptedTurnClosers(session.snapshotEvents())).toEqual([])
    expect(resultEvents(session)).toHaveLength(2)
  })

  it('closes only the still-open boundary when the crash landed after the repair', () => {
    const { session } = openStep({
      calls: ['c1', 'c2'],
      started: ['c1'],
      answered: ['c1'],
    })
    expect(session.closeUnansweredToolCalls(1, 1)).toBe(1)

    const closers = interruptedTurnClosers(session.snapshotEvents())
    expect(closers.map(event => event.type)).toEqual(['step/end', 'turn/end'])
    expect(closers.some(event => event.type === 'tool/result')).toBe(false)
    expect(resultEvents(session)).toHaveLength(2)
  })
})
