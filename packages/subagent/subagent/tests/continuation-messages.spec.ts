import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { ToolCallId, boundContextSummary, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import {
  CHILD_TOOL_BUDGET,
  DEFAULT_SETTLEMENT_REPORT_MAX_CHARS,
  DEFAULT_SETTLEMENT_REPORT_MAX_IMAGES,
  createSettlementMessage,
  withChildBudgetGuidance,
} from '../src/continuation-messages.ts'

const childId = SessionId('settled-child')
const limits = { maxChars: DEFAULT_SETTLEMENT_REPORT_MAX_CHARS, maxImages: DEFAULT_SETTLEMENT_REPORT_MAX_IMAGES }
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
    const message = createSettlementMessage(childId, { stopReason: 'completed', output }, { limits })

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
    const message = createSettlementMessage(childId, { stopReason: 'completed', ...output === undefined ? {} : { output } }, { limits })

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
    }, { limits })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'Its closing message:' },
      first,
      second,
    ])
  })

  it.each([
    ['aborted', `${subject} was stopped before it finished — inspect its session ${childId} or continue it with a follow-up.`],
    ['max-tokens', `${subject} hit the output token limit and used up its automatic continuations before it finished — continue it with a follow-up.`],
    ['refusal', `${subject} declined the task — inspect its session ${childId} or continue it with a follow-up.`],
    ['error', `${subject} failed before it finished — inspect its session ${childId} or continue it with a follow-up.`],
  ] as const)('names the session and the continue-by-id option for a child stopped with %s', (stopReason, expected) => {
    const message = createSettlementMessage(childId, { stopReason, output: [{ type: 'text', text: 'partial report' }] }, { limits })

    expect(message.content[0]).toEqual({ type: 'text', text: expected })
    expect(message.content).toContainEqual({ type: 'text', text: 'partial report' })
    expect(message.source).toEqual({
      kind: 'subagent-settled',
      form: 'notice',
      summary: boundContextSummary(expected),
      senderSessionId: childId,
    })
  })

  it('bounds and sanitizes the failure diagnostic without reasoning or credentials', () => {
    const secret = 'sk-abcdefghijklmnop '
    const long = `${secret}${'x'.repeat(4_000)}`
    const message = createSettlementMessage(childId, {
      stopReason: 'error',
      failure: { code: 'PROVIDER ERROR!' },
      lastSuccessfulOperation: { seq: SessionSeq(42) },
      lastPublicText: long,
    }, { limits })

    const text = message.content
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('\n')
    expect(text).toContain('Diagnostic: code=PROVIDERERROR; recoverability=unknown; '
      + 'last successful tool result at event seq 42.')
    expect(text).toContain('Last public text before the ending (unverified):')
    expect(text).toContain('[redacted]')
    expect(text).not.toContain(secret.trim())
    expect(text.length).toBeLessThan(2_000)
    expect(text).not.toContain('private child reasoning')
  })

  it('truncates a multibyte public excerpt at a UTF-8 boundary', () => {
    const message = createSettlementMessage(childId, {
      stopReason: 'error',
      failure: { code: 'E' },
      lastPublicText: '权限'.repeat(300),
    }, { limits })
    const blocks = message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
    const excerpt = blocks.find(text => text.includes('权限'))
    expect(excerpt?.endsWith('…')).toBe(true)
    expect(blocks.join('\n')).not.toContain('\uFFFD')
  })

  it('reports unknown rather than an unsafe failure code', () => {
    const message = createSettlementMessage(childId, {
      stopReason: 'error',
      failure: { code: '***' },
    }, { limits })
    expect(message.content[1]).toEqual({
      type: 'text',
      text: 'Diagnostic: code=UNKNOWN; recoverability=unknown.',
    })
  })

  it('states a recoverable ending positively', () => {
    const message = createSettlementMessage(childId, {
      stopReason: 'error',
      failure: { code: 'RETRYABLE', recoverable: true },
    }, { limits })
    expect(message.content[1]).toEqual({
      type: 'text',
      text: 'Diagnostic: code=RETRYABLE; recoverability=yes.',
    })
  })

  it('keeps an image in the closing report while excluding nontext diagnostics', () => {
    const image: ContentBlock = {
      type: 'image',
      attachment: {
        attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
        mediaType: 'image/png',
        bytes: 1,
        width: 1,
        height: 1,
      },
    }
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [reasoning, { type: 'text', text: 'answer' }, image],
    }, { limits })
    expect(message.content).toContainEqual(image)
    expect(message.content).not.toContainEqual(reasoning)
  })

  it('states a provably discarded ending as not recoverable', () => {
    const message = createSettlementMessage(childId, {
      stopReason: 'refusal',
      failure: { code: 'TURN_BLOCKED', recoverable: false },
    }, { limits })
    expect(message.content[1]).toEqual({
      type: 'text',
      text: 'Diagnostic: code=TURN_BLOCKED; recoverability=no (the ending discarded the input).',
    })
  })

  it('states the stale persisted state when the final session flush failed', () => {
    const message = createSettlementMessage(childId, { stopReason: 'completed' }, { limits, flushFailed: true })
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

/** One attachment reference used by the image-bound tests. */
function imageOf(index: number): ContentBlock {
  return {
    type: 'image',
    attachment: {
      attachmentId: AttachmentId(`sha256:${String(index).padStart(64, '0')}`),
      mediaType: 'image/png',
      bytes: index + 1,
      width: 1,
      height: 1,
    },
  }
}

/** Whether a retained string starts or ends on half a surrogate pair. */
function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true
      index += 1
      continue
    }
    if (code >= 0xDC00 && code <= 0xDFFF) return true
  }
  return false
}

/** Model-visible text of one notice, in block order. */
function noticeTexts(message: ReturnType<typeof createSettlementMessage>): string[] {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
}

/** The exact omission line for one bound and report. */
function omissionLine(
  omittedChars: number,
  totalChars: number,
  omittedImages: number,
  totalImages: number,
): string {
  const parts: string[] = []
  if (omittedChars > 0) parts.push(`${String(omittedChars)} of ${String(totalChars)} characters omitted`)
  if (omittedImages > 0) parts.push(`${String(omittedImages)} of ${String(totalImages)} images omitted`)
  const child = JSON.stringify(childId)
  return `The closing report was shortened for this notice: ${parts.join(' and ')}. `
    + `The child's complete report is durable in its session ${child}; read it with `
    + `session_event_search({ session_id: ${child}, query: "<distinctive phrase>" }) and open a hit with `
    + `session_event_read({ session_id: ${child}, seq: <hit event seq> }).`
}

describe('bounded closing report', () => {
  it('keeps a report at the exact character bound byte-identical', () => {
    const report = 'x'.repeat(100)
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [{ type: 'text', text: report }],
    }, { limits: { maxChars: 100, maxImages: 4 } })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'Its closing message:' },
      { type: 'text', text: report },
    ])
  })

  it('shortens a report one character over the bound and states the exact omission', () => {
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [{ type: 'text', text: 'abcdefghij' }],
    }, { limits: { maxChars: 9, maxImages: 4 } })

    expect(noticeTexts(message)).toEqual([
      `Background subagent ${childId} finished.`,
      'Its closing message:',
      'abcde',
      'ghij',
      omissionLine(1, 10, 0, 0),
    ])
  })

  it('keeps both ends of a multibyte report without splitting surrogate pairs', () => {
    const report = '😀'.repeat(10)
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [{ type: 'text', text: report }],
    }, { limits: { maxChars: 6, maxImages: 4 } })

    const texts = noticeTexts(message)
    expect(texts.slice(2, 4)).toEqual(['😀', '😀'])
    expect(texts[4]).toBe(omissionLine(16, 20, 0, 0))
    for (const text of texts) expect(hasLoneSurrogate(text)).toBe(false)
  })

  it('never splits a surrogate pair when a tiny budget leaves an empty excerpt', () => {
    const report = '😀😀😀'
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [{ type: 'text', text: report }],
    }, { limits: { maxChars: 2, maxImages: 4 } })

    expect(noticeTexts(message)).toEqual([
      `Background subagent ${childId} finished.`,
      'Its closing message:',
      omissionLine(6, 6, 0, 0),
    ])
  })

  it('keeps a whole-line head and tail when the bounds land mid-line', () => {
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [{ type: 'text', text: 'one\ntwo\nthree\nfour' }],
    }, { limits: { maxChars: 10, maxImages: 4 } })

    expect(noticeTexts(message).slice(2, 4)).toEqual(['one\n', 'four'])
    expect(noticeTexts(message)[4]).toBe(omissionLine(10, 18, 0, 0))
  })

  it('joins multiple text blocks before bounding them', () => {
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [{ type: 'text', text: 'HEAD' }, reasoning, { type: 'text', text: 'TAIL' }],
    }, { limits: { maxChars: 4, maxImages: 4 } })

    const texts = noticeTexts(message)
    // Four characters over two blocks join as "HEAD\nTAIL": the head budget
    // keeps "HE", the tail budget keeps "IL".
    expect(texts.slice(2, 4)).toEqual(['HE', 'IL'])
    expect(texts[4]).toBe(omissionLine(5, 9, 0, 0))
    expect(texts).not.toContain('private child reasoning')
  })

  it('keeps the first images and states the image omission without a text omission', () => {
    const images = [0, 1, 2].map(imageOf)
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [{ type: 'text', text: 'answer' }, ...images],
    }, { limits: { maxChars: 100, maxImages: 2 } })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'Its closing message:' },
      { type: 'text', text: 'answer' },
      images[0],
      images[1],
      { type: 'text', text: omissionLine(0, 0, 1, 3) },
    ])
  })

  it('counts characters and images together when both bounds bind', () => {
    const images = [0, 1, 2].map(imageOf)
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [{ type: 'text', text: 'abcdefghij' }, ...images],
    }, { limits: { maxChars: 8, maxImages: 1 } })

    const texts = noticeTexts(message)
    expect(texts).toContain(omissionLine(2, 10, 2, 3))
    expect(message.content.filter(block => block.type === 'image')).toEqual([images[0]])
  })

  it('drops both excerpts under a zero character budget and keeps the omission line', () => {
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [{ type: 'text', text: 'abcdefghij' }],
    }, { limits: { maxChars: 0, maxImages: 4 } })

    expect(noticeTexts(message)).toEqual([
      `Background subagent ${childId} finished.`,
      'Its closing message:',
      omissionLine(10, 10, 0, 0),
    ])
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
