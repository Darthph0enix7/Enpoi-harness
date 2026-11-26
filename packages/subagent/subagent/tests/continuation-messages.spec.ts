import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { ToolCallId, boundContextSummary, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { SpillLocator } from '@deepseek-ai/dsh-spill'
import {
  CHILD_TOOL_BUDGET,
  DEFAULT_SETTLEMENT_REPORT_HARD_MAX_CHARS,
  DEFAULT_SETTLEMENT_REPORT_MAX_CHARS,
  DEFAULT_SETTLEMENT_REPORT_MAX_IMAGES,
  DEFAULT_SETTLEMENT_REPORT_OUTLINE_MAX_CHARS,
  DEFAULT_SETTLEMENT_SPILL_MAX_LINE_CHARS,
  DEFAULT_SETTLEMENT_SPILL_TIMEOUT_MS,
  buildMarkdownOutline,
  closingReportNeedsSpill,
  createSettlementMessage,
  prepareSpillText,
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

/** The exact child-session pointer clause for one child id. */
function childSessionPointer(id: SessionId = childId, also = false): string {
  const child = JSON.stringify(id)
  return `The child's complete report is ${also ? 'also ' : ''}durable in its session ${child}; read it with `
    + `session_event_search({ session_id: ${child}, query: "<distinctive phrase>" }) and open a hit with `
    + `session_event_read({ session_id: ${child}, seq: <hit event seq> }).`
}

/** The exact fallback omission line when no spill file was written. */
function fallbackOmissionLine(
  omittedChars: number,
  totalChars: number,
  omittedImages: number,
  totalImages: number,
  reason = 'spill storage unavailable',
): string {
  const parts: string[] = []
  if (omittedChars > 0) parts.push(`${String(omittedChars)} of ${String(totalChars)} characters omitted`)
  if (omittedImages > 0) parts.push(`${String(omittedImages)} of ${String(totalImages)} images omitted`)
  return `The closing report was shortened for this notice: ${parts.join(' and ')}. `
    + `No file copy was saved (${reason}). `
    + childSessionPointer()
}

describe('bounded closing report', () => {
  it('exposes the expected defaults', () => {
    expect(DEFAULT_SETTLEMENT_REPORT_MAX_CHARS).toBe(12_000)
    expect(DEFAULT_SETTLEMENT_REPORT_MAX_IMAGES).toBe(4)
    expect(DEFAULT_SETTLEMENT_REPORT_HARD_MAX_CHARS).toBe(200_000)
    expect(DEFAULT_SETTLEMENT_REPORT_OUTLINE_MAX_CHARS).toBe(1_500)
    expect(DEFAULT_SETTLEMENT_SPILL_MAX_LINE_CHARS).toBe(1_800)
    expect(DEFAULT_SETTLEMENT_SPILL_TIMEOUT_MS).toBe(5_000)
  })

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

  it('shortens a report over the bound while keeping total emitted closing report inside maxChars', () => {
    const report = `${'A'.repeat(400)}${'M'.repeat(400)}${'Z'.repeat(400)}`
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [{ type: 'text', text: report }],
    }, { limits: { maxChars: 600, maxImages: 4 } })

    const texts = noticeTexts(message)
    expect(texts[0]).toBe(`Background subagent ${childId} finished.`)
    expect(texts[1]).toBe('Its closing message:')
    const head = texts[2]!
    const tail = texts[3]!
    const pointer = texts[4]!
    expect(head.startsWith('AAAA')).toBe(true)
    expect(tail.endsWith('ZZZZ')).toBe(true)
    expect(head.length + tail.length + pointer.length).toBeLessThanOrEqual(600)
    const omitted = report.length - head.length - tail.length
    expect(pointer).toBe(fallbackOmissionLine(omitted, report.length, 0, 0))
  })

  it('keeps both ends of a multibyte report without splitting surrogate pairs or graphemes', () => {
    const report = `${'😀'.repeat(300)}${'x'.repeat(500)}${'👨‍👩‍👧‍👦'.repeat(60)}`
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [{ type: 'text', text: report }],
    }, { limits: { maxChars: 700, maxImages: 4 } })

    const texts = noticeTexts(message)
    expect(texts[2]).toContain('😀')
    expect(texts[3]).toContain('👨‍👩‍👧‍👦')
    for (const text of texts) expect(hasLoneSurrogate(text)).toBe(false)
    const bodyChars = texts.slice(2).reduce((sum, item) => sum + item.length, 0)
    expect(bodyChars).toBeLessThanOrEqual(700)
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
      fallbackOmissionLine(6, 6, 0, 0),
    ])

    // When remaining excerpt budget is 2 code units and ends/starts on a wide grapheme, both bounds safely return ''.
    const wideGrapheme = '👨‍👩‍👧‍👦'.repeat(60)
    const wideFallback = fallbackOmissionLine(wideGrapheme.length, wideGrapheme.length, 0, 0)
    const tightMsg = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [{ type: 'text', text: wideGrapheme }],
    }, { limits: { maxChars: wideFallback.length + 2, maxImages: 4 } })
    expect(noticeTexts(tightMsg)).toEqual([
      `Background subagent ${childId} finished.`,
      'Its closing message:',
      wideFallback,
    ])
    // Also exercise tailCutIndex surrogate adjustment and 0-outlineBudget branch when remainingForContent === 1.
    const surrReport = `${'a'.repeat(500)}${'😀'.repeat(100)}end`
    const surrLocator = SpillLocator('/tmp/spill/s.md')
    const surrPrep = prepareSpillText(surrReport, 1_800)
    const surrPointerWorst = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [{ type: 'text', text: surrReport }],
    }, {
      limits: { maxChars: 0, maxImages: 4 },
      spill: {
        status: 'saved',
        ref: { locator: surrLocator, bytes: surrPrep.content.length, retrievalHint: 'read' },
        savedLineNumbers: surrPrep.savedLineNumbers,
        lines: surrPrep.lines,
        wrappedLines: surrPrep.wrappedLines,
      },
    })
    const pointerLen = noticeTexts(surrPointerWorst).at(-1)!.length
    const oneLeft = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [{ type: 'text', text: surrReport }],
    }, {
      limits: { maxChars: pointerLen + 1, maxImages: 4 },
      spill: {
        status: 'saved',
        ref: { locator: surrLocator, bytes: surrPrep.content.length, retrievalHint: 'read' },
        savedLineNumbers: surrPrep.savedLineNumbers,
        lines: surrPrep.lines,
        wrappedLines: surrPrep.wrappedLines,
      },
    })
    for (const text of noticeTexts(oneLeft)) expect(hasLoneSurrogate(text)).toBe(false)
    const midSurrogate = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [{ type: 'text', text: `${'a'.repeat(300)}${'😀'.repeat(100)}` }],
    }, { limits: { maxChars: fallbackOmissionLine(500, 500, 0, 0).length + 260, maxImages: 4 } })
    for (const text of noticeTexts(midSurrogate)) expect(hasLoneSurrogate(text)).toBe(false)
  })

  it('keeps a whole-line head and tail when the bounds land mid-line', () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line-${String(index).padStart(2, '0')}-${'x'.repeat(20)}`)
    const report = lines.join('\n')
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [{ type: 'text', text: report }],
    }, { limits: { maxChars: 600, maxImages: 4 } })

    const texts = noticeTexts(message)
    const head = texts[2]!
    const tail = texts[3]!
    expect(head.endsWith('\n')).toBe(true)
    expect(tail.startsWith('line-')).toBe(true)
    expect(head.length + tail.length + texts[4]!.length).toBeLessThanOrEqual(600)
  })

  it('joins multiple text blocks before bounding them', () => {
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [{ type: 'text', text: `HEAD${'a'.repeat(400)}` }, reasoning, { type: 'text', text: `${'b'.repeat(400)}TAIL` }],
    }, { limits: { maxChars: 550, maxImages: 4 } })

    const texts = noticeTexts(message)
    expect(texts[2]).toContain('HEAD')
    expect(texts[3]).toContain('TAIL')
    expect(texts).not.toContain('private child reasoning')
    expect(texts.slice(2).reduce((sum, item) => sum + item.length, 0)).toBeLessThanOrEqual(550)
  })

  it('keeps the first images and states the image omission without a text omission', () => {
    const images = [0, 1, 2].map(imageOf)
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [{ type: 'text', text: 'answer' }, ...images],
    }, { limits: { maxChars: 1_000, maxImages: 2 } })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'Its closing message:' },
      { type: 'text', text: 'answer' },
      images[0],
      images[1],
      { type: 'text', text: fallbackOmissionLine(0, 0, 1, 3) },
    ])
  })

  it('checks the image cap even when the closing report has no text', () => {
    const images = [0, 1, 2].map(imageOf)
    const limits = { maxChars: 1_000, maxImages: 2 }
    expect(closingReportNeedsSpill(images, limits)).toEqual({ text: '', needsSpill: true })
    const notice = createSettlementMessage(childId, { stopReason: 'completed', output: images }, {
      limits,
      spill: { status: 'failed', reason: 'spill storage unavailable' },
    })
    expect(notice.content.filter(block => block.type === 'image')).toEqual(images.slice(0, 2))
    expect(noticeTexts(notice).at(-1)).toBe(fallbackOmissionLine(0, 0, 1, 3))
  })

  it('counts characters and images together when both bounds bind', () => {
    const images = [0, 1, 2].map(imageOf)
    const report = 'a'.repeat(1_000)
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [{ type: 'text', text: report }, ...images],
    }, { limits: { maxChars: 600, maxImages: 1 } })

    const texts = noticeTexts(message)
    const head = texts[2]!
    const tail = texts[3]!
    const pointer = texts[4]!
    expect(pointer).toBe(fallbackOmissionLine(report.length - head.length - tail.length, report.length, 2, 3))
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
      fallbackOmissionLine(10, 10, 0, 0),
    ])
  })

  it('emits spill locator, markdown outline with 1-based line numbers, read/grep calls, and child pointer within budget', () => {
    const report = [
      '# Overview',
      'Intro text '.repeat(40),
      '```markdown',
      '# Not A Heading Inside Code Fence',
      '```',
      '## Findings',
      'Detail text '.repeat(40),
      '### Recommendations',
      'Final text '.repeat(40),
    ].join('\n')
    const prepared = prepareSpillText(report, 1_800)
    const locator = SpillLocator('/tmp/spill/subagent-closing-report.md')
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [{ type: 'text', text: report }],
    }, {
      limits: { maxChars: 1_200, maxImages: 4, outlineMaxChars: 1_500 },
      spill: {
        status: 'saved',
        ref: { locator, bytes: Buffer.byteLength(prepared.content, 'utf8'), retrievalHint: 'use read' },
        savedLineNumbers: prepared.savedLineNumbers,
        lines: prepared.lines,
        wrappedLines: prepared.wrappedLines,
      },
    })

    const texts = noticeTexts(message)
    const closingBody = texts.slice(2)
    expect(closingBody.join('\n').length).toBeLessThanOrEqual(1_200)
    const joined = closingBody.join('\n')
    expect(joined).toContain('Outline (1-based line numbers in saved file):')
    expect(joined).toContain('L1: # Overview')
    expect(joined).toContain('L6: ## Findings')
    expect(joined).toContain('L8: ### Recommendations')
    expect(joined).not.toContain('Not A Heading Inside Code Fence')
    expect(joined).toContain(`Full report text saved at ${JSON.stringify(locator)} (${Buffer.byteLength(prepared.content, 'utf8')} bytes, ${prepared.lines} lines).`)
    expect(joined).toContain(`read({ file_path: ${JSON.stringify(locator)}, offset: <line>, limit: <n> })`)
    expect(joined).toContain(`grep({ pattern: "<phrase>", path: ${JSON.stringify(locator)} })`)
    expect(joined).toContain(childSessionPointer(childId, true))
  })

  it('caps the markdown outline at outlineMaxChars and states how many more headings exist', () => {
    const headings = Array.from({ length: 30 }, (_, index) => `## Section ${index + 1}: ${'Title '.repeat(5).trim()}`)
    const outline = buildMarkdownOutline(headings.join('\n'), 220)
    expect(outline.length).toBeLessThanOrEqual(220)
    expect(outline).toContain('L1: ## Section 1:')
    expect(outline).toMatch(/\.\.\. \(\d+ more headings?\)$/)

    // Singular trailer, long heading clipping, CRLF, empty heading, tilde/backtick fences, and zero/tiny caps.
    const edgeMd = [
      '#   \r',
      '````\r',
      '```\r',
      '# Ignored Four-Backtick Fence\r',
      '````\r',
      '```inline` not-a-fence',
      '~~~\r',
      '# Ignored Tilde Fence\r',
      '~~~\r',
      `# ${'LongHeadingWord'.repeat(15)} ##`,
      `## ${'SecondHeadingMuchLongerTitle'.repeat(6)}`,
    ].join('\n')
    const clipped = buildMarkdownOutline(edgeMd, 195)
    expect(clipped).toContain('…')
    expect(clipped).toContain('... (1 more heading)')
    expect(clipped).not.toContain('Ignored Tilde Fence')
    expect(clipped).not.toContain('Ignored Four-Backtick Fence')
    expect(buildMarkdownOutline(edgeMd, 0)).toBe('')
    expect(buildMarkdownOutline(edgeMd, 20)).toBe('')
    expect(buildMarkdownOutline('plain text only', 500)).toBe('')
    expect(prepareSpillText('', 100)).toEqual({ content: '', lines: 0, wrappedLines: 0 })
    expect(prepareSpillText('line1\n', 100)).toEqual({ content: 'line1\n', lines: 1, wrappedLines: 0 })
    // Single grapheme wider than maxLineChars emits intact without marking wrappedLines > 0.
    expect(prepareSpillText('👨‍👩‍👧‍👦', 4)).toEqual({ content: '👨‍👩‍👧‍👦', lines: 1, wrappedLines: 0 })
    expect(closingReportNeedsSpill([], { maxChars: 100, maxImages: 4 })).toEqual({ text: '', needsSpill: false })
    expect(closingReportNeedsSpill([{ type: 'reasoning', text: 'hidden' }], { maxChars: 100, maxImages: 4 })).toEqual({
      text: '',
      needsSpill: false,
    })
    // Short report with image overflow budgets both excerpt captions and separators.
    const shortMsg = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [{ type: 'text', text: 'a'.repeat(50) }, imageOf(0)],
    }, { limits: { maxChars: fallbackOmissionLine(50, 50, 1, 1).length + 12, maxImages: 0 } })
    expect(noticeTexts(shortMsg)[2]).toBe('aaaaa')
    expect(noticeTexts(shortMsg)[3]).toBe('aaaaa')
  })

  it('wraps long single lines without removing characters and notes wrapping in the notice', () => {
    const longLine = `${'alpha '.repeat(250)}${'beta'.repeat(100)}`
    const report = `# Title\n${longLine}\n## Tail\nend`
    const prepared = prepareSpillText(report, 100)
    const physicalLines = prepared.content.split('\n')
    for (const line of physicalLines) {
      expect(line.length).toBeLessThanOrEqual(100)
    }
    expect(prepared.wrappedLines).toBe(1)
    // Concatenating wrapped segments of line 2 restores the exact original line.
    const wrappedChunkCount = physicalLines.length - 3
    expect(physicalLines.slice(1, 1 + wrappedChunkCount).join('')).toBe(longLine)

    const locator = SpillLocator('/tmp/spill/wrapped.md')
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [{ type: 'text', text: report }],
    }, {
      limits: { maxChars: 900, maxImages: 4, spillMaxLineChars: 100 },
      spill: {
        status: 'saved',
        ref: { locator, bytes: Buffer.byteLength(prepared.content, 'utf8'), retrievalHint: 'use read' },
        savedLineNumbers: prepared.savedLineNumbers,
        lines: prepared.lines,
        wrappedLines: prepared.wrappedLines,
      },
    })
    const joined = noticeTexts(message).join('\n')
    expect(joined).toContain('Long lines (> 100 chars) were wrapped in the saved file with no characters removed')
    expect(joined).toContain(`L${String(1 + wrappedChunkCount + 1)} (original L3): ## Tail`)
  })

  it('wraps multibyte and grapheme-clustered long lines without splitting pairs or graphemes', () => {
    const longEmoji = `${'👨‍👩‍👧‍👦'.repeat(20)}${'😀'.repeat(40)}${'e\u0301'.repeat(40)}`
    const prepared = prepareSpillText(longEmoji, 25)
    const physicalLines = prepared.content.split('\n')
    expect(physicalLines.length).toBeGreaterThan(1)
    for (const line of physicalLines) {
      expect(hasLoneSurrogate(line)).toBe(false)
      expect(line.startsWith('\u200D')).toBe(false)
      expect(line.startsWith('\u0301')).toBe(false)
    }
    expect(physicalLines.join('')).toBe(longEmoji)
  })

  it('states omitted images live in the child session and are not in the text spill file', () => {
    const images = [0, 1, 2].map(imageOf)
    const locator = SpillLocator('/tmp/spill/images.md')
    const report = 'Summary text'
    const prepared = prepareSpillText(report, 1_800)
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [{ type: 'text', text: report }, ...images],
    }, {
      limits: { maxChars: 1_500, maxImages: 1 },
      spill: {
        status: 'saved',
        ref: { locator, bytes: Buffer.byteLength(prepared.content, 'utf8'), retrievalHint: 'use read' },
        savedLineNumbers: prepared.savedLineNumbers,
        lines: prepared.lines,
        wrappedLines: prepared.wrappedLines,
      },
    })
    const joined = noticeTexts(message).join('\n')
    expect(joined).toContain('2 of 3 images omitted')
    expect(joined).toContain(`Omitted images are not in this text file; look for them in child session ${JSON.stringify(childId)}.`)
    expect(joined).toContain(JSON.stringify(childId))
    expect(message.content.filter(block => block.type === 'image')).toEqual([images[0]])
  })

  it('respects reportMode full-inline up to hardMaxChars and spills beyond it', () => {
    const medium = 'm'.repeat(500)
    expect(closingReportNeedsSpill([{ type: 'text', text: medium }], {
      maxChars: 100,
      maxImages: 4,
      hardMaxChars: 1_000,
    }, 'full-inline').needsSpill).toBe(false)

    const inlineMessage = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [{ type: 'text', text: medium }],
    }, {
      limits: { maxChars: 100, maxImages: 4, hardMaxChars: 1_000 },
      reportMode: 'full-inline',
    })
    expect(noticeTexts(inlineMessage)).toEqual([
      `Background subagent ${childId} finished.`,
      'Its closing message:',
      medium,
    ])

    const huge = 'h'.repeat(1_500)
    expect(closingReportNeedsSpill([{ type: 'text', text: huge }], {
      maxChars: 100,
      maxImages: 4,
      hardMaxChars: 1_000,
    }, 'full-inline').needsSpill).toBe(true)

    const locator = SpillLocator('/tmp/spill/huge.md')
    const prepared = prepareSpillText(huge, 1_800)
    const spilledMessage = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [{ type: 'text', text: huge }],
    }, {
      limits: { maxChars: 100, maxImages: 4, hardMaxChars: 1_000 },
      reportMode: 'full-inline',
      spill: {
        status: 'saved',
        ref: { locator, bytes: Buffer.byteLength(prepared.content, 'utf8'), retrievalHint: 'use read' },
        savedLineNumbers: prepared.savedLineNumbers,
        lines: prepared.lines,
        wrappedLines: prepared.wrappedLines,
      },
    })
    const closingChars = noticeTexts(spilledMessage).slice(2).reduce((sum, item) => sum + item.length, 0)
    expect(closingChars).toBeLessThanOrEqual(1_000)
    expect(noticeTexts(spilledMessage).join('\n')).toContain(JSON.stringify(locator))
  })

  it('prefers full inline up to hardMaxChars when both spill failed and final flush failed', () => {
    const report = 's'.repeat(500)
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [{ type: 'text', text: report }],
    }, {
      limits: { maxChars: 100, maxImages: 4, hardMaxChars: 1_000 },
      flushFailed: true,
      spill: { status: 'failed', reason: 'spill save failed' },
    })

    expect(noticeTexts(message)).toEqual([
      `Background subagent ${childId} finished. Its final session flush failed, so its persisted state may be stale.`,
      'Its closing message:',
      report,
      expect.stringContaining(`No file copy was saved (spill save failed). The original report may be incomplete in child session ${JSON.stringify(childId)}`),
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
