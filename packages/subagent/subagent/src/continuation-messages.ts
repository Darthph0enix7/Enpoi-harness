/**
 * Model-visible messages owned by continuable-subagent orchestration: adjacent
 * Agent messages, return guidance, and settlement notices. A stopped epoch's
 * notice carries one bounded diagnostic line built from the child's own log —
 * ending code, known recoverability, last successful tool-result seq, and an
 * unverified public-text excerpt. The closing report copied from the child is
 * bounded by its own character and image limits; a truncated report states the
 * exact omission and names the child's durable session. Provider error text and
 * reasoning never enter it; common credential forms are redacted best-effort,
 * not a security scanner.
 *
 * @module @deepseek-ai/dsh-subagent/continuation-messages
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ActivationTerminal } from './lifecycle.ts'

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

/**
 * Bounds applied to the closing report a settlement notice copies into the
 * parent context. The complete report always remains in the child's own
 * durable session; these limits only decide how much of it rides the notice.
 */
export interface SettlementReportLimits {
  /** Maximum UTF-16 code units of closing report text retained in the notice. */
  readonly maxChars: number
  /** Maximum image blocks retained in the notice, in report order. */
  readonly maxImages: number
}

/** Inputs for {@link createSettlementMessage}. */
export interface SettlementMessageOptions {
  /** Bounds applied to the child's closing report. */
  readonly limits: SettlementReportLimits
  /** Whether the epoch's final session flush failed; the notice then states that persisted state may be stale. Defaults to false. */
  readonly flushFailed?: boolean
}

/**
 * Whether a UTF-16 code unit begins a surrogate pair.
 * @param code - one UTF-16 code unit.
 * @returns whether the unit is a high surrogate.
 */
function isHighSurrogate(code: number): boolean {
  return code >= 0xD800 && code <= 0xDBFF
}

/**
 * Whether a UTF-16 code unit ends a surrogate pair.
 * @param code - one UTF-16 code unit.
 * @returns whether the unit is a low surrogate.
 */
function isLowSurrogate(code: number): boolean {
  return code >= 0xDC00 && code <= 0xDFFF
}

/**
 * Move a prefix end left when it would split a surrogate pair.
 * @param text - text being cut.
 * @param end - proposed exclusive prefix end.
 * @returns a prefix end that does not split a pair.
 */
function headCutIndex(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return Math.max(0, Math.min(end, text.length))
  return isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))
    ? end - 1
    : end
}

/**
 * Move a suffix start right when it would split a surrogate pair.
 * @param text - text being cut.
 * @param start - proposed inclusive suffix start.
 * @returns a suffix start that does not split a pair.
 */
function tailCutIndex(text: string, start: number): number {
  if (start <= 0 || start >= text.length) return Math.max(0, Math.min(start, text.length))
  return isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))
    ? start + 1
    : start
}

/**
 * Keep a bounded prefix, preferring the last whole line inside the budget.
 * @param text - the complete closing report.
 * @param budget - maximum retained UTF-16 code units.
 * @returns the retained prefix, never splitting a surrogate pair.
 */
function headBound(text: string, budget: number): string {
  const end = headCutIndex(text, budget)
  const newline = text.lastIndexOf('\n', end - 1)
  return text.slice(0, newline > 0 ? newline + 1 : end)
}

/**
 * Keep a bounded suffix, preferring the first whole line inside the budget.
 * @param text - the complete closing report.
 * @param budget - maximum retained UTF-16 code units.
 * @returns the retained suffix, never splitting a surrogate pair.
 */
function tailBound(text: string, budget: number): string {
  const start = tailCutIndex(text, text.length - budget)
  const newline = text.indexOf('\n', start)
  return newline !== -1 && newline + 1 < text.length
    ? text.slice(newline + 1)
    : text.slice(start)
}

/**
 * The closing report blocks a notice carries after applying its bounds, plus
 * the one model-facing line that states what was left out.
 */
interface BoundedClosingReport {
  /** Retained report content in notice order: head text, tail text, images. */
  readonly content: readonly ContentBlock[]
  /** Omission line, absent when every report block fits. */
  readonly truncation: string | undefined
}

/**
 * Apply the notice bounds to one closing report. Untouched reports keep their
 * original blocks and order; a bounded report keeps a head and tail excerpt of
 * the joined text and the first images, and states the exact omission.
 * @param childId - durable child session named by the omission line.
 * @param output - the child's final assistant content blocks.
 * @param limits - character and image ceilings for the notice.
 * @returns retained content and the omission line when anything was left out.
 */
function boundClosingReport(
  childId: SessionId,
  output: readonly ContentBlock[],
  limits: SettlementReportLimits,
): BoundedClosingReport {
  const texts = output.flatMap(block => block.type === 'text' && block.text.length > 0 ? [block.text] : [])
  const images = output.flatMap(block => block.type === 'image' ? [block] : [])
  const retainedImages = images.slice(0, Math.max(0, limits.maxImages))
  const omittedImages = images.length - retainedImages.length
  const report = texts.join('\n')
  if (report.length <= limits.maxChars && omittedImages === 0) {
    return {
      content: output.filter(
        (block): block is Extract<ContentBlock, { type: 'text' | 'image' }> =>
          block.type === 'text' || block.type === 'image',
      ),
      truncation: undefined,
    }
  }
  const headBudget = Math.ceil(limits.maxChars / 2)
  const tailBudget = limits.maxChars - headBudget
  const head = report.length <= limits.maxChars ? report : headBound(report, headBudget)
  const tail = report.length <= limits.maxChars ? '' : tailBound(report, tailBudget)
  const omittedChars = report.length - head.length - tail.length
  const parts: string[] = []
  if (omittedChars > 0) parts.push(`${String(omittedChars)} of ${String(report.length)} characters omitted`)
  if (omittedImages > 0) parts.push(`${String(omittedImages)} of ${String(images.length)} images omitted`)
  const child = JSON.stringify(childId)
  return {
    content: [
      ...head.length === 0 ? [] : [{ type: 'text' as const, text: head }],
      ...tail.length === 0 ? [] : [{ type: 'text' as const, text: tail }],
      ...retainedImages,
    ],
    truncation: `The closing report was shortened for this notice: ${parts.join(' and ')}. `
      + `The child's complete report is durable in its session ${child}; read it with `
      + `session_event_search({ session_id: ${child}, query: "<distinctive phrase>" }) and open a hit with `
      + `session_event_read({ session_id: ${child}, seq: <hit event seq> }).`,
  }
}

/**
 * Build the `Its closing message:` section for a report that has nonempty text.
 * @param childId - durable child session named by a shortened report's line.
 * @param output - the child's final assistant content blocks.
 * @param limits - character and image ceilings for the notice.
 * @returns the section heading, retained report content, and any omission line.
 */
function closingReportBlocks(
  childId: SessionId,
  output: readonly ContentBlock[],
  limits: SettlementReportLimits,
): ContentBlock[] {
  const report = boundClosingReport(childId, output, limits)
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
  const closing: ContentBlock[] = closingText.length === 0
    ? [
      ...excerpt === ''
        ? []
        : [
          { type: 'text' as const, text: 'Last public text before the ending (unverified):' },
          { type: 'text' as const, text: excerpt },
        ],
      { type: 'text' as const, text: 'It left no closing message.' },
    ]
    : closingReportBlocks(childId, output, options.limits)
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
