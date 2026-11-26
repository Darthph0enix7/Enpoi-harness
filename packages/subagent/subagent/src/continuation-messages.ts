/**
 * Model-visible messages owned by continuable-subagent orchestration: adjacent
 * Agent messages, return guidance, and settlement notices. A stopped epoch's
 * notice carries one bounded diagnostic line built from the child's own log —
 * ending code, known recoverability, last successful tool-result seq, and an
 * unverified public-text excerpt. The closing report copied from the child is
 * bounded by its own character and image limits; a shortened report states the
 * omission and names the child session and any saved spill. Provider error text and
 * reasoning never enter it; common credential forms are redacted best-effort,
 * not a security scanner.
 *
 * @module @deepseek-ai/dsh-subagent/continuation-messages
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SpillRef } from '@deepseek-ai/dsh-spill'
import type { ActivationTerminal } from './lifecycle.ts'
import type { SubagentReportMode } from './types.ts'

/** Durable attribution for one model-authored message between adjacent Agents. */
export interface AgentMessageSource {
  readonly kind: 'agent-message'
  /** A message another agent addressed to this one (`relay` context form). */
  readonly form: 'relay'
  /** Session id of the Agent whose tool call produced the message. */
  readonly senderSessionId: SessionId
}

/**
 * Durable attribution for the runtime's own account of a continuable child
 * settling. Deliberately a different kind from
 * {@link AgentMessageSource}: an Agent message is content the sender chose,
 * while this message is the manager stating what became of the child, and a
 * transcript that merged them would credit the child with words it never wrote.
 */
export interface SubagentSettledMessageSource {
  readonly kind: 'subagent-settled'
  /** A runtime account shown without expanding the row (`notice` context form). */
  readonly form: 'notice'
  /** One-line account of how the child ended. */
  readonly summary: string
  /** Session id of the child that settled. */
  readonly senderSessionId: SessionId
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'agent-message': AgentMessageSource
    'subagent-settled': SubagentSettledMessageSource
  }
}

/** Build durable attribution for one adjacent-Agent message. */
function agentMessageSource(sender: Agent): AgentMessageSource {
  return {
    kind: 'agent-message',
    form: 'relay',
    senderSessionId: sender.id,
  }
}

/**
 * Build the model-visible and durable representation of one adjacent-Agent message.
 * @param sender - exact live Agent that authored the message.
 * @param content - model-visible message blocks supplied by the sender.
 * @returns the durable user-message representation delivered to the recipient.
 */
export function createAgentMessage(
  sender: Agent,
  content: ContentBlock[],
): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [
      { type: 'text' as const, text: `Agent ${sender.id} sent a message: ` },
      ...content,
    ],
    source: agentMessageSource(sender),
  })
}

/**
 * Append adjacent-Agent return guidance to a continuable child's initial task.
 * @param parentId - durable parent session id named in the guidance.
 * @param prompt - initial model-visible task blocks.
 * @returns task blocks followed by the continuable return guidance.
 */
export function withContinuableReturnGuidance(
  parentId: SessionId,
  prompt: ContentBlock[],
): ContentBlock[] {
  const encodedParentId = JSON.stringify(parentId)
  return [
    ...prompt,
    {
      type: 'text',
      text: `Your parent agent id is ${encodedParentId}. Before you finish, send your result to that agent with `
        + `send_message({ agent_id: ${encodedParentId}, message: "<self-contained result>" }). The parent shares `
        + 'your workspace but does not automatically receive your transcript, tool output, or reasoning. Send '
        + 'earlier messages as well when a finding changes what the parent should do next; sending a message '
        + 'does not end your turn.',
    },
  ]
}

/** Tool-call budget a delegated child keeps unless its parent sets another. */
export const CHILD_TOOL_BUDGET = 20

/**
 * Append the standing delegation budget to a child's initial task. Applied to
 * every continuable child so the stop rule does not depend on the parent
 * remembering to write one into its Task Card.
 * @param prompt - initial model-visible task blocks.
 * @returns task blocks followed by the budget guidance.
 */
export function withChildBudgetGuidance(prompt: ContentBlock[]): ContentBlock[] {
  return [
    ...prompt,
    {
      type: 'text',
      text: `Delegation budget: ${String(CHILD_TOOL_BUDGET)} tool calls is a ceiling for exploration, not a `
        + 'counter to satisfy — most tasks finish well under it. Stop as soon as the answer is complete: cite '
        + 'the files and lines that ground it and report. If you cannot answer inside the budget, report what '
        + 'you tried and what is still missing instead of continuing.',
    },
  ]
}

/** Character ceiling for a failure code copied from a provider or harness ending. */
const FAILURE_CODE_MAX_CHARS = 64
/** UTF-8 byte ceiling for the child's last public text quoted in a notice. */
const PUBLIC_TEXT_MAX_BYTES = 512
const PUBLIC_TEXT_TRUNCATION_SUFFIX = '…'
const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

/** Default character ceiling for a settled child's closing report in a notice. */
export const DEFAULT_SETTLEMENT_REPORT_MAX_CHARS = 12_000
/** Default image-block ceiling for a settled child's closing report in a notice. */
export const DEFAULT_SETTLEMENT_REPORT_MAX_IMAGES = 4
/** Default hard character ceiling for full-inline overrides and stale-flush fallbacks. */
export const DEFAULT_SETTLEMENT_REPORT_HARD_MAX_CHARS = 200_000
/** Default character ceiling for the Markdown heading outline in a spilled notice. */
export const DEFAULT_SETTLEMENT_REPORT_OUTLINE_MAX_CHARS = 1_500
/** Default maximum UTF-16 code units per physical line in a spilled closing-report file. */
export const DEFAULT_SETTLEMENT_SPILL_MAX_LINE_CHARS = 1_800
/** Default timeout in milliseconds when saving a closing report through `ctx.spillStore`. */
export const DEFAULT_SETTLEMENT_SPILL_TIMEOUT_MS = 5_000
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * Bounds applied to the closing report a settlement notice copies into the
 * parent context, including retrieval text. These limits also govern the
 * formatting of a saved text copy, not the original report in the child log.
 */
export interface SettlementReportLimits {
  /** Maximum UTF-16 code units of closing report text retained in the notice. */
  readonly maxChars: number
  /** Maximum image blocks retained in the notice, in report order. */
  readonly maxImages: number
  /** Hard UTF-16 ceiling for `reportMode: 'full-inline'` and stale-flush fallback. Defaults to 200000. */
  readonly hardMaxChars?: number
  /** Maximum UTF-16 characters of the Markdown heading outline in a spilled notice. Defaults to 1500. */
  readonly outlineMaxChars?: number
  /** Maximum UTF-16 characters per line in a spilled file before wrapping. Defaults to 1800. */
  readonly spillMaxLineChars?: number
  /** Timeout in milliseconds for `spillStore.saveText`. Defaults to 5000. */
  readonly spillTimeoutMs?: number
}

/** Fully resolved settlement report limits with all defaults materialized. */
export interface ResolvedSettlementReportLimits {
  readonly maxChars: number
  readonly maxImages: number
  readonly hardMaxChars: number
  readonly outlineMaxChars: number
  readonly spillMaxLineChars: number
  readonly spillTimeoutMs: number
}

/** Result of attempting to spill an oversized closing report before building a notice. */
export type SettlementSpillOutcome =
  | {
    readonly status: 'saved'
    readonly ref: SpillRef
    readonly savedLineNumbers?: readonly number[] | undefined
    readonly lines: number
    readonly wrappedLines: number
  }
  | {
    readonly status: 'failed'
    readonly reason: string
  }

/** Inputs for {@link createSettlementMessage}. */
export interface SettlementMessageOptions {
  /** Bounds applied to the child's closing report. */
  readonly limits: SettlementReportLimits
  /** Whether the epoch's final session flush failed; the notice then states that persisted state may be stale. Defaults to false. */
  readonly flushFailed?: boolean
  /** Per-spawn override controlling whether the report bypasses `maxChars` up to `hardMaxChars`. */
  readonly reportMode?: SubagentReportMode
  /** Result of spilling an oversized closing report, when attempted. */
  readonly spill?: SettlementSpillOutcome
}

/**
 * Resolve optional fields on {@link SettlementReportLimits} to their canonical defaults.
 * @param limits - caller-supplied limits.
 * @returns resolved limits with every bound defined.
 */
export function resolveSettlementReportLimits(limits: SettlementReportLimits): ResolvedSettlementReportLimits {
  return {
    maxChars: Math.max(0, limits.maxChars),
    maxImages: Math.max(0, limits.maxImages),
    hardMaxChars: Math.max(0, limits.hardMaxChars ?? DEFAULT_SETTLEMENT_REPORT_HARD_MAX_CHARS),
    outlineMaxChars: Math.max(0, limits.outlineMaxChars ?? DEFAULT_SETTLEMENT_REPORT_OUTLINE_MAX_CHARS),
    spillMaxLineChars: Math.max(1, limits.spillMaxLineChars ?? DEFAULT_SETTLEMENT_SPILL_MAX_LINE_CHARS),
    spillTimeoutMs: Math.max(1, limits.spillTimeoutMs ?? DEFAULT_SETTLEMENT_SPILL_TIMEOUT_MS),
  }
}

/**
 * Keep a bounded prefix, preferring the last whole line inside the budget and
 * never splitting a surrogate pair or grapheme cluster.
 * @param text - the complete closing report.
 * @param budget - maximum retained UTF-16 code units.
 * @returns the retained prefix, never splitting a grapheme cluster.
 */
function headBound(text: string, budget: number): string {
  if (budget <= 0) return ''
  const end = graphemeSegmenter.segment(text).containing(budget)?.index ?? text.length
  if (end <= 0) return ''
  const newline = text.lastIndexOf('\n', end - 1)
  return text.slice(0, newline > 0 ? newline + 1 : end)
}

/**
 * Keep a bounded suffix, preferring the first whole line inside the budget and
 * never splitting a surrogate pair or grapheme cluster.
 * @param text - the complete closing report.
 * @param budget - maximum retained UTF-16 code units.
 * @returns the retained suffix, never splitting a grapheme cluster.
 */
function tailBound(text: string, budget: number): string {
  if (budget <= 0) return ''
  const minStart = text.length - budget
  if (minStart <= 0) return text
  const segment = graphemeSegmenter.segment(text).containing(minStart)
  const start = segment === undefined ? text.length : segment.index === minStart
    ? minStart
    : segment.index + segment.segment.length
  if (start >= text.length) return ''
  const newline = text.indexOf('\n', start)
  return newline !== -1 && newline + 1 < text.length
    ? text.slice(newline + 1)
    : text.slice(start)
}

/**
 * Wrap one single line into pieces at most `maxChars` UTF-16 code units long,
 * preferring a space boundary and never splitting a surrogate pair or grapheme
 * cluster or removing any characters.
 */
function wrapLineGraphemeSafe(line: string, maxChars: number): string[] {
  const out: string[] = []
  let start = 0
  let lastSpace = 0
  for (const { index, segment } of graphemeSegmenter.segment(line)) {
    const end = index + segment.length
    if (end - start > maxChars && index > start) {
      if (lastSpace > start) {
        out.push(line.slice(start, lastSpace))
        start = lastSpace
      }
      if (end - start > maxChars && index > start) {
        out.push(line.slice(start, index))
        start = index
      }
    }
    if (segment === ' ') lastSpace = end
  }
  out.push(line.slice(start))
  return out
}

/** Count physical lines using the same EOF semantics as `tool-fs`'s `read` renderer. */
function countFileLines(text: string): number {
  if (text.length === 0) return 0
  let count = 0
  let pos = 0
  while ((pos = text.indexOf('\n', pos)) !== -1) {
    count += 1
    pos += 1
  }
  return text.endsWith('\n') ? count : count + 1
}

/**
 * Line-wrap long lines in a closing report for safe `read` inspection without
 * removing characters, returning the wrapped text, physical line count, and
 * count of original lines that were wrapped.
 * @param report - the complete unwrapped closing report text.
 * @param maxLineChars - maximum UTF-16 characters per physical line before wrapping.
 * @returns wrapped content and counts, with original-to-saved line positions when wrapping occurred.
 */
export function prepareSpillText(
  report: string,
  maxLineChars: number,
): { readonly content: string; readonly lines: number; readonly wrappedLines: number; readonly savedLineNumbers?: readonly number[] } {
  const sourceLines = report.split('\n')
  const outLines: string[] = []
  const savedLineNumbers: number[] = []
  let wrappedLines = 0
  for (const line of sourceLines) {
    savedLineNumbers.push(outLines.length + 1)
    if (line.length > maxLineChars && maxLineChars > 0) {
      const wrapped = wrapLineGraphemeSafe(line, maxLineChars)
      if (wrapped.length > 1) wrappedLines += 1
      for (const piece of wrapped) outLines.push(piece)
    } else {
      outLines.push(line)
    }
  }
  const content = outLines.join('\n')
  return { content, lines: countFileLines(content), wrappedLines, ...wrappedLines > 0 ? { savedLineNumbers } : {} }
}

/** Clip a heading at a grapheme boundary so one label leaves room for other entries. */
function clipHeadingLabel(text: string, budget: number): string {
  if (text.length <= budget) return text
  const prefix = headBound(text, budget - 1)
  return `${prefix.trimEnd()}…`
}

/**
 * Extract a deterministic outline of Markdown ATX headings with 1-based line
 * numbers from the original report, capped at `maxChars` UTF-16 code units. Headings
 * inside fenced code blocks (` ``` ` / `~~~`) are ignored.
 * @param text - original text before wrapping.
 * @param maxChars - maximum UTF-16 code units for the complete rendered outline.
 * @param savedLineNumbers - saved-file positions by original line, when wrapping shifted them.
 * @returns the formatted outline, or `''` when no headings exist or none fit.
 */
export function buildMarkdownOutline(text: string, maxChars: number, savedLineNumbers?: readonly number[]): string {
  if (maxChars <= 0 || text.length === 0) return ''
  const labelBudget = Math.max(1, Math.floor(maxChars / 2))
  const entries: string[] = []
  let fence: { char: string; length: number } | undefined
  for (const [index, rawLine] of text.split('\n').entries()) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const [, marker, rest = ''] = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line) ?? []
    if (marker !== undefined) {
      const char = marker.charAt(0)
      if (fence === undefined) {
        if (char !== '`' || !rest.includes('`')) {
          fence = { char, length: marker.length }
        }
        continue
      }
      if (char === fence.char && marker.length >= fence.length && rest.trim() === '') {
        fence = undefined
      }
      continue
    }
    if (fence !== undefined) continue
    const [, hashes, label] = /^ {0,3}(#{1,6})[ \t]+(.+)$/.exec(line) ?? []
    if (hashes === undefined || label === undefined) continue
    const title = label.replace(/[ \t]+#+\s*$/, '').trim()
    if (title.length === 0) continue
    const saved = savedLineNumbers?.[index] ?? index + 1
    const original = saved === index + 1 ? '' : ` (original L${String(index + 1)})`
    entries.push(`L${String(saved)}${original}: ${hashes} ${clipHeadingLabel(title, labelBudget)}`)
  }
  if (entries.length === 0) return ''

  const header = 'Outline (1-based line numbers in saved file):'
  const full = `${header}\n${entries.join('\n')}`
  if (full.length <= maxChars) return full

  const kept: string[] = []
  let usedChars = header.length
  for (const [i, entry] of entries.entries()) {
    const remaining = entries.length - (i + 1)
    const trailer = remaining === 0
      ? ''
      : `\n... (${String(remaining)} more heading${remaining === 1 ? '' : 's'})`
    const candidateLen = usedChars + 1 + entry.length + trailer.length
    if (candidateLen > maxChars) break
    kept.push(entry)
    usedChars += 1 + entry.length
  }
  const omittedCount = entries.length - kept.length
  const trailer = `... (${String(omittedCount)} more heading${omittedCount === 1 ? '' : 's'})`
  if (kept.length === 0) return trailer.length <= maxChars ? trailer : ''
  return `${header}\n${kept.join('\n')}\n${trailer}`
}

/**
 * Determine whether a child's closing output exceeds the effective report bounds
 * and therefore needs a spill write before building the settlement notice.
 * @param output - the child's final assistant content blocks.
 * @param limits - settlement report limits.
 * @param reportMode - per-spawn report mode (`'bounded'` by default).
 * @returns the joined closing text and whether a spill write is required.
 */
export function closingReportNeedsSpill(
  output: readonly ContentBlock[],
  limits: SettlementReportLimits,
  reportMode?: SubagentReportMode,
): { readonly text: string; readonly needsSpill: boolean } {
  const resolved = resolveSettlementReportLimits(limits)
  const texts = output.flatMap(block => block.type === 'text' && block.text.length > 0 ? [block.text] : [])
  const text = texts.join('\n')
  const imageCount = output.reduce((count, block) => count + (block.type === 'image' ? 1 : 0), 0)
  const effectiveMaxChars = reportMode === 'full-inline' ? resolved.hardMaxChars : resolved.maxChars
  const needsSpill = text.length > effectiveMaxChars || imageCount > resolved.maxImages
  return { text, needsSpill }
}

/**
 * The closing report blocks a notice carries after applying its bounds, plus
 * the one model-facing line that states what was left out.
 */
interface BoundedClosingReport {
  /** Retained report content in notice order: head text, tail text, optional outline, images. */
  readonly content: readonly ContentBlock[]
  /** Pointer / omission line, absent when every report block fits. */
  readonly truncation: string | undefined
}

/** Format the lossless pointer and omission summary for a shortened closing report. */
function formatShortenedPointer(
  childId: SessionId,
  omittedChars: number,
  totalChars: number,
  omittedImages: number,
  totalImages: number,
  spill: SettlementSpillOutcome | undefined,
  spillMaxLineChars: number,
  flushFailed: boolean,
): string {
  const parts: string[] = []
  if (omittedChars > 0) parts.push(`${String(omittedChars)} of ${String(totalChars)} characters omitted`)
  if (omittedImages > 0) parts.push(`${String(omittedImages)} of ${String(totalImages)} images omitted`)
  const child = JSON.stringify(childId)
  const childPointer = formatChildReportPointer(child, spill?.status === 'saved', flushFailed)
  if (spill?.status === 'saved') {
    const encodedLocator = JSON.stringify(spill.ref.locator)
    const wrappedNote = spill.wrappedLines > 0
      ? ` Long lines (> ${String(spillMaxLineChars)} chars) were wrapped in the saved file with no characters removed.`
      : ''
    const imageNote = omittedImages > 0
      ? ` Omitted images are not in this text file; look for them in child session ${child}.`
      : ''
    return `The closing report was shortened for this notice: ${parts.join(' and ')}. `
      + `Full report text saved at ${encodedLocator} (${String(spill.ref.bytes)} bytes, ${String(spill.lines)} lines).${wrappedNote}${imageNote} `
      + `Read a section with read({ file_path: ${encodedLocator}, offset: <line>, limit: <n> }) `
      + `or search it with grep({ pattern: "<phrase>", path: ${encodedLocator} }). `
      + childPointer
  }
  const reason = spill?.status === 'failed' ? spill.reason : 'spill storage unavailable'
  return `The closing report was shortened for this notice: ${parts.join(' and ')}. `
    + `No file copy was saved (${reason}). `
    + childPointer
}

/** Name the original report location without promising a copy after a failed flush. */
function formatChildReportPointer(child: string, spilled: boolean, flushFailed: boolean): string {
  const intro = flushFailed
    ? `The original report may be incomplete in child session ${child}; `
    : `The child's complete report is ${spilled ? 'also ' : ''}durable in its session ${child}; `
  return intro + `read it with session_event_search({ session_id: ${child}, query: "<distinctive phrase>" }) and open a hit with `
    + `session_event_read({ session_id: ${child}, seq: <hit event seq> }).`
}

/**
 * Apply the notice bounds to one closing report. Untouched reports keep their
 * original blocks and order; a bounded report keeps a head and tail excerpt of
 * the joined text, an optional Markdown outline, the first images, and states
 * the exact omission plus the spill locator (when saved) and child-session pointer.
 * @param childId - durable child session named by the omission line.
 * @param output - the child's final assistant content blocks.
 * @param options - closing-report bounds, mode, flush status, and spill outcome.
 * @returns retained content and the pointer line when anything was left out.
 */
function boundClosingReport(
  childId: SessionId,
  output: readonly ContentBlock[],
  options: SettlementMessageOptions,
): BoundedClosingReport {
  const resolved = resolveSettlementReportLimits(options.limits)
  const texts = output.flatMap(block => block.type === 'text' && block.text.length > 0 ? [block.text] : [])
  const images = output.flatMap(block => block.type === 'image' ? [block] : [])
  const retainedImages = images.slice(0, resolved.maxImages)
  const omittedImages = images.length - retainedImages.length
  const report = texts.join('\n')

  let effectiveMaxChars = options.reportMode === 'full-inline' ? resolved.hardMaxChars : resolved.maxChars
  if (options.flushFailed && options.spill?.status === 'failed') {
    effectiveMaxChars = resolved.hardMaxChars
  }

  if (report.length <= effectiveMaxChars && omittedImages === 0) {
    return {
      content: output.filter(
        (block): block is Extract<ContentBlock, { type: 'text' | 'image' }> =>
          block.type === 'text' || block.type === 'image',
      ),
      truncation: options.spill?.status === 'failed'
        ? `No file copy was saved (${options.spill.reason}). `
          + formatChildReportPointer(JSON.stringify(childId), false, options.flushFailed ?? false)
        : undefined,
    }
  }

  const worstPointer = formatShortenedPointer(
    childId,
    report.length,
    report.length,
    omittedImages,
    images.length,
    options.spill,
    resolved.spillMaxLineChars,
    options.flushFailed ?? false,
  )
  const remainingForContent = Math.max(0, effectiveMaxChars - worstPointer.length)
  let head = ''
  let tail = ''
  const outlineBudget = Math.min(resolved.outlineMaxChars, Math.floor(remainingForContent / 2))
  const outline = options.spill?.status === 'saved'
    ? buildMarkdownOutline(report, outlineBudget, options.spill.savedLineNumbers)
    : ''
  // Account for the newlines between nonempty text blocks and the pointer.
  const remainingWithOutline = remainingForContent - (outline === '' ? 0 : outline.length + 1)
  if (omittedImages > 0 && report.length + 1 <= remainingWithOutline) {
    head = report
  } else {
    const excerptBudget = Math.max(0, remainingWithOutline - 2)
    const headBudget = Math.ceil(excerptBudget / 2)
    const tailBudget = excerptBudget - headBudget
    head = headBound(report, headBudget)
    tail = tailBound(report, tailBudget)
  }

  const omittedChars = report.length - head.length - tail.length
  const pointer = formatShortenedPointer(
    childId,
    omittedChars,
    report.length,
    omittedImages,
    images.length,
    options.spill,
    resolved.spillMaxLineChars,
    options.flushFailed ?? false,
  )

  return {
    content: [
      ...head.length === 0 ? [] : [{ type: 'text' as const, text: head }],
      ...tail.length === 0 ? [] : [{ type: 'text' as const, text: tail }],
      ...outline.length === 0 ? [] : [{ type: 'text' as const, text: outline }],
      ...retainedImages,
    ],
    truncation: pointer,
  }
}

/**
 * Build the `Its closing message:` section for a report that has nonempty text.
 * @param childId - durable child session named by a shortened report's line.
 * @param output - the child's final assistant content blocks.
 * @param options - closing-report bounds, mode, flush status, and spill outcome.
 * @returns the section heading, retained report content, and any omission line.
 */
function closingReportBlocks(
  childId: SessionId,
  output: readonly ContentBlock[],
  options: SettlementMessageOptions,
): ContentBlock[] {
  const report = boundClosingReport(childId, output, options)
  return [
    { type: 'text', text: 'Its closing message:' },
    ...report.content,
    ...report.truncation === undefined ? [] : [{ type: 'text' as const, text: report.truncation }],
  ]
}

/**
 * Limit diagnostic text to a UTF-8 byte budget without splitting a sequence.
 * @param text - already redacted text.
 * @returns the original text, or a visibly truncated prefix.
 */
function limitDiagnosticBytes(text: string): string {
  const bytes = utf8Encoder.encode(text)
  if (bytes.byteLength <= PUBLIC_TEXT_MAX_BYTES) return text
  let prefixBytes = PUBLIC_TEXT_MAX_BYTES - utf8Encoder.encode(PUBLIC_TEXT_TRUNCATION_SUFFIX).byteLength
  while (prefixBytes > 0 && ((bytes[prefixBytes] as number) & 0b1100_0000) === 0b1000_0000) {
    prefixBytes -= 1
  }
  return utf8Decoder.decode(bytes.subarray(0, prefixBytes)) + PUBLIC_TEXT_TRUNCATION_SUFFIX
}

/**
 * Keep only characters that name a stable failure code. A provider code is
 * model-facing structure, never free text; an empty or wholly unsafe value is
 * reported as `UNKNOWN` instead of being guessed at.
 * @param code - the recorded ending code.
 * @returns a bounded code safe to place in the notice.
 */
function diagnosticCode(code: string): string {
  const cleaned = code.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, FAILURE_CODE_MAX_CHARS)
  return cleaned === '' ? 'UNKNOWN' : cleaned
}

/**
 * Quote the child's last public text without its reasoning, tool traffic, or
 * common credential forms. The parent already has the child's session for
 * details; this bounded excerpt only preserves what was visible before the
 * ending.
 * @param text - the last text-only assistant content in the epoch.
 * @returns a bounded, redacted excerpt.
 */
function publicTextExcerpt(text: string): string {
  const cleaned = text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\b(sk-[a-z0-9_-]{8,}|Bearer\s+[a-z0-9._~+/=-]{8,}|api[_-]?key\s*[:=]\s*\S+)/gi, '[redacted]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return limitDiagnosticBytes(cleaned)
}

/**
 * One structured line naming what the log proves about a child that stopped
 * before finishing: the ending code, what is known about recoverability, the
 * seq of its last successful tool result when one exists, and that the quoted
 * text is evidence rather than verification.
 * @param terminal - recorded terminal state for the settled Activation.
 * @returns the diagnostic line, or `undefined` for a completed epoch.
 */
function diagnosticSummary(terminal: ActivationTerminal): string | undefined {
  const failure = terminal.failure
  if (failure === undefined) return undefined
  const parts = [
    `code=${diagnosticCode(failure.code)}`,
    `recoverability=${failure.recoverable === undefined
      ? 'unknown'
      : failure.recoverable ? 'yes' : 'no (the ending discarded the input)'}`,
  ]
  const operation = terminal.lastSuccessfulOperation
  if (operation !== undefined) {
    parts.push(`last successful tool result at event seq ${Number(operation.seq)}`)
  }
  return `Diagnostic: ${parts.join('; ')}.`
}

/**
 * One line telling a parent that a background child is finished and why, in
 * the parent's own task vocabulary. A failed final flush is stated in the same
 * line: the parent must not read "finished" as "fully persisted".
 * @param childId - the durable child the parent knows by id.
 * @param terminal - recorded terminal state for the settled Activation.
 * @param flushFailed - whether the epoch's final session flush failed.
 * @returns the model-facing opening line of the settlement notice.
 */
function settlementSummary(
  childId: SessionId,
  terminal: ActivationTerminal,
  flushFailed: boolean,
): string {
  const subject = `Background subagent ${childId}`
  // A stopped-before-finished child is recoverable: the notice names the
  // session so the parent can inspect it or continue it by id. New work stays
  // a fresh dispatch; this hint is for deliberate recovery only. The hint
  // states a capability, not a promise that the failed work recovers.
  const recovery = `inspect its session ${childId} or continue it with a follow-up`
  const code = terminal.failure === undefined ? undefined : diagnosticCode(terminal.failure.code)
  const summary = (() => {
    switch (terminal.stopReason) {
      case 'completed':
        // enpoi: a completed child is the normal end of a dispatch. A deliberate
        // follow-up can still reach it by id; the next task is a fresh dispatch.
        return `${subject} finished.`
      case 'aborted':
        return `${subject} was stopped before it finished — ${recovery}.`
      case 'max-tokens':
        // The epoch already ran its automatic continuations; seeing this notice
        // means that ceiling is spent, so finishing the answer is the parent's
        // decision now.
        return `${subject} hit the output token limit and used up its automatic continuations `
          + 'before it finished — continue it with a follow-up.'
      // A pre-step rejection — a hook deny, a policy plugin — discarded input
      // the child had claimed, so the parent must not treat the task as done.
      case 'refusal':
        return `${subject} declined the task — ${recovery}.`
      case 'error':
        return `${subject} failed before it finished${code === undefined ? '' : ` (code: ${code})`} — ${recovery}.`
      /* v8 ignore next 4 -- `SubagentResult['stopReason']` is merge-extensible, so this arm
       * needs a backend that adds a variant; an unnameable ending is reported as unfinished
       * rather than silently as success. */
      default:
        return `${subject} ended abnormally (${String(terminal.stopReason)}) before it finished — ${recovery}.`
    }
  })()
  return flushFailed
    ? `${summary} Its final session flush failed, so its persisted state may be stale.`
    : summary
}

/**
 * Build the runtime-owned settlement notice from the child's nonempty closing text.
 * @param childId - durable child session id named in the notice.
 * @param terminal - recorded terminal state for the settled Activation.
 * @param options - closing-report bounds and whether the epoch's final flush
 *   failed; a failed flush makes the notice state that persisted child state
 *   may be stale.
 * @returns the durable user-message representation delivered to the parent.
 */
export function createSettlementMessage(
  childId: SessionId,
  terminal: ActivationTerminal,
  options: SettlementMessageOptions,
): ReturnType<typeof createUserMessage> {
  const summary = settlementSummary(childId, terminal, options.flushFailed ?? false)
  // Parent providers receive this notice as a user message and may reject
  // nontext assistant blocks. Keep this conversion local so SDK/UI consumers
  // retain the complete child output.
  const output = terminal.output ?? []
  const closingText = output.flatMap(block =>
    block.type === 'text' && block.text.length > 0 ? [block] : [],
  )
  const diagnostic = diagnosticSummary(terminal)
  // The closing report already carries the last visible text when it has any;
  // only a failure whose final assistant message was nontext needs the earlier
  // public excerpt. Reasoning and tool traffic never reach this value.
  const excerpt = terminal.failure !== undefined && closingText.length === 0
    && terminal.lastPublicText !== undefined
    ? publicTextExcerpt(terminal.lastPublicText)
    : ''
  // Only the child's final REPORT reaches the parent: reasoning and tool-call
  // blocks (its thinking and intermediate actions) are stripped, mirroring the
  // foreground path. Images ride along: they are legitimate report content,
  // bounded by the notice limits.
  const closing: ContentBlock[] = closingText.length === 0 && options.spill === undefined
    ? [
      ...excerpt === ''
        ? []
        : [
          { type: 'text' as const, text: 'Last public text before the ending (unverified):' },
          { type: 'text' as const, text: excerpt },
        ],
      { type: 'text' as const, text: 'It left no closing message.' },
    ]
    : closingReportBlocks(childId, output, options)
  return createUserMessage({
    content: [
      { type: 'text' as const, text: summary },
      ...diagnostic === undefined ? [] : [{ type: 'text' as const, text: diagnostic }],
      ...closing,
    ],
    source: {
      kind: 'subagent-settled' as const,
      form: 'notice' as const,
      summary: boundContextSummary(summary),
      senderSessionId: childId,
    },
  })
}
