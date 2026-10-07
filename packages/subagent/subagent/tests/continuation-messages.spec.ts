import { describe, expect, it } from 'vitest'
import { ToolCallId, boundContextSummary, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { CHILD_TOOL_BUDGET, createSettlementMessage, withChildBudgetGuidance } from '../src/continuation-messages.ts'

const childId = SessionId('settled-child')
const subject = `Background subagent ${childId}`
const summary = { type: 'text', text: `Background subagent ${childId} finished.` }
const reasoning: ContentBlock = { type: 'reasoning', text: 'private child reasoning' }
const toolCall: ContentBlock = { type: 'tool-call', id: ToolCallId('child-call'), name: 'read', arguments: '{}' }

describe('continuable settlement content', () => {
  it.each([
    ['reasoning before the answer', [reasoning, { type: 'text', text: 'answer' }]],
    ['a tool call after the answer', [{ type: 'text', text: 'answer' }, toolCall]],
  ] satisfies [string, ContentBlock[]][])('reports only the closing text with %s', (_label, output) => {
    const original = structuredClone(output)
    const message = createSettlementMessage(childId, { stopReason: 'completed', output })

    expect(message.role).toBe('user')
    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'Its closing message:' },
      { type: 'text', text: 'answer' },
    ])
    expect(output).toEqual(original)
  })

  it.each([
    ['absent output', undefined],
    ['empty output', []],
    ['reasoning-only output', [reasoning]],
    ['empty text', [{ type: 'text', text: '' }]],
  ] satisfies [string, ContentBlock[] | undefined][])('reports no closing message for %s', (_label, output) => {
    const message = createSettlementMessage(childId, { stopReason: 'completed', ...output === undefined ? {} : { output } })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'It left no closing message.' },
    ])
  })

  it('preserves text block order and bytes around omitted reasoning and tool calls', () => {
    const first: ContentBlock = { type: 'text', text: '  first\n' }
    const second: ContentBlock = { type: 'text', text: '\n第二段  ' }
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [reasoning, first, toolCall, second],
    })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'Its closing message:' },
      first,
      second,
    ])
  })

  it.each([
    ['aborted', `${subject} was stopped before it finished — inspect its session ${childId} or continue it with a follow-up.`],
    ['max-tokens', `${subject} ran out of room before it finished — inspect its session ${childId} or continue it with a follow-up.`],
    ['refusal', `${subject} declined the task — inspect its session ${childId} or continue it with a follow-up.`],
    ['error', `${subject} failed before it finished — inspect its session ${childId} or continue it with a follow-up.`],
  ] as const)('names the session and the continue-by-id option for a child stopped with %s', (stopReason, expected) => {
    const message = createSettlementMessage(childId, { stopReason, output: [{ type: 'text', text: 'partial report' }] })

    expect(message.content[0]).toEqual({ type: 'text', text: expected })
    expect(message.content).toContainEqual({ type: 'text', text: 'partial report' })
    expect(message.source).toEqual({
      kind: 'subagent-settled',
      form: 'notice',
      summary: boundContextSummary(expected),
      senderSessionId: childId,
    })
  })

  it('states the stale persisted state when the final session flush failed', () => {
    const message = createSettlementMessage(childId, { stopReason: 'completed' }, true)
    const stated = `${subject} finished. Its final session flush failed, so its persisted state may be stale.`

    // Both the model-visible opening line and the collapsed summary row carry
    // the true state: "finished" alone would overstate durability.
    expect(message.content[0]).toEqual({ type: 'text', text: stated })
    expect(message.source).toEqual({
      kind: 'subagent-settled',
      form: 'notice',
      summary: boundContextSummary(stated),
      senderSessionId: childId,
    })
  })
})

describe('delegation budget guidance', () => {
  it('appends the ceiling and outcome stop to a child task', () => {
    const prompt: ContentBlock[] = [{ type: 'text', text: 'Map the registry.' }]
    const original = structuredClone(prompt)
    const guided = withChildBudgetGuidance(prompt)
    expect(guided).toHaveLength(2)
    expect(guided[0]).toEqual(prompt[0])
    const guidance = guided[1]
    expect(guidance?.type).toBe('text')
    const body = (guidance as { text: string }).text
    expect(body).toContain(`${String(CHILD_TOOL_BUDGET)} tool calls is a ceiling for exploration`)
    expect(body).toContain('not a counter to satisfy')
    expect(body).toContain('most tasks finish well under it')
    expect(body).toContain('Stop as soon as the answer is complete')
    expect(body).toContain('report what you tried and what is still missing')
    expect(prompt).toEqual(original)
  })
})
