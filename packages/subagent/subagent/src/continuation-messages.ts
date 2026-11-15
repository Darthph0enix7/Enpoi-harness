/**
 * Model-visible messages owned by continuable-subagent orchestration: adjacent
 * Agent messages, return guidance, and settlement notices. A stopped epoch's
 * notice carries one bounded diagnostic line built from the child's own log —
 * ending code, known recoverability, last successful tool-result seq, and an
 * unverified public-text excerpt. Provider error text and reasoning never enter
 * it; common credential forms are redacted best-effort, not a security scanner.
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
 * @param flushFailed - whether the epoch's final session flush failed; the
 *   notice then states that the persisted child state may be stale.
 * @returns the durable user-message representation delivered to the parent.
 */
export function createSettlementMessage(
  childId: SessionId,
  terminal: ActivationTerminal,
  flushFailed = false,
): ReturnType<typeof createUserMessage> {
  const summary = settlementSummary(childId, terminal, flushFailed)
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
  return createUserMessage({
    content: [
      { type: 'text' as const, text: summary },
      ...diagnostic === undefined ? [] : [{ type: 'text' as const, text: diagnostic }],
      ...closingText.length === 0
        ? [
          ...excerpt === ''
            ? []
            : [
              { type: 'text' as const, text: 'Last public text before the ending (unverified):' },
              { type: 'text' as const, text: excerpt },
            ],
          { type: 'text' as const, text: 'It left no closing message.' },
        ]
        : [
          { type: 'text' as const, text: 'Its closing message:' },
          // Only the child's final REPORT reaches the parent: reasoning and
          // tool-call blocks (its thinking and intermediate actions) are
          // stripped, mirroring the foreground path. Images ride along: they
          // are legitimate report content.
          ...output.filter(
            (block): block is Extract<ContentBlock, { type: 'text' | 'image' }> =>
              block.type === 'text' || block.type === 'image',
          ),
        ],
    ],
    source: {
      kind: 'subagent-settled' as const,
      form: 'notice' as const,
      summary: boundContextSummary(summary),
      senderSessionId: childId,
    },
  })
}
