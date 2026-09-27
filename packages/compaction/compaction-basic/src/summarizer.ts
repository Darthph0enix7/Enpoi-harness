/**
 * Default one-shot summarization, window-aware input framing, deterministic
 * mechanical omission framing, and durable checkpoint framing.
 *
 * @module @deepseek-ai/dsh-compaction-basic/summarizer
 */

import type { Context } from '@deepseek-ai/cordis'
import { contentHasImage, BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type {
  ContentBlock, FinishReason, GenerateOptions, Message, RequestMessage, RequestUserInput, TokenUsage, ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionSeq } from '@deepseek-ai/dsh-session'

/** Summariser routing plus the generation cap this package sends. */
export interface SummaryConfig {
  readonly summarizationProvider: string
  readonly summarizationModel: string
  /** Model-group id the summariser route was resolved through, when a seat named a chain. */
  readonly summarizationChain?: string
  readonly maxTokens: number
}

/** Tags wrapping the structured summary inside the landed checkpoint node. */
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/**
 * The summarization directive, delivered as the FINAL user message after the
 * replayed conversation rather than as a distinct summarizer system prompt.
 * Keeping the conversation's own system prompt, tools, and message prefix in
 * front of it makes the auxiliary call a genuine prefix of the last routed
 * request, so the provider's KV cache is reused instead of invalidated.
 */
const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

/** Framing that makes the replacement user message established context. */
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/**
 * Lead-in for the deterministic, model-free omission stub that replaces the
 * oldest part of a span when summarization fails. It states what happened and
 * how to recover detail, so the resumed model can ask for what it needs.
 */
const OMISSION_PREAMBLE =
  'This is an automatically generated omission notice. No model summary was available, so the oldest part of an earlier conversation span was removed from the live context to keep the session within its context budget. The complete transcript is preserved in the session log. Recover anything you need from the removed span with session_event_search (keywords), session_event_read (seq), or session_search.'

/** Audit text recorded as the `compaction/summary` body for a mechanical omission. */
export const MECHANICAL_SUMMARY_TEXT =
  'Mechanical fallback: the summarizer was unavailable, so the oldest part of this span was replaced with an omission notice. The span remains in the session log and is retrievable with session_event_search or session_event_read.'

/**
 * The replayed conversation surface the summarizer condenses. Reproducing the
 * last routed request's system prompt, tools, and leading messages verbatim
 * lets the auxiliary call reuse the provider's warm prefix cache; the trailing
 * compaction instruction is then the only novel input.
 */
export interface SummarizationInput {
  /** The conversation's tool schemas, reused for prefix-cache alignment; absent when the request carried none. */
  readonly tools?: readonly ToolSchema[]
  /** The derived system head, when present, followed by the shadowed region in surface order. */
  readonly messages: readonly Message[]
}

/** Optional framing supplied by the engine after it resolves the summariser window. */
export interface SummarizationFraming {
  /**
   * Input-token budget of the summariser's own context window, after the
   * output reservation. When the replay exceeds it, the oldest region messages
   * are left out of this call and the durable checkpoint records the gap.
   */
  readonly inputBudgetTokens?: number
}

/** Safe summary content plus the exact auxiliary call envelope recorded with it. */
export type SummaryResult = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  /** Provider-reported usage for this summarization request. */
  usage?: TokenUsage
  /**
   * The replay was capped to the summariser window, so the summary covers only
   * its newest messages. The durable checkpoint framing documents the gap.
   */
  windowClipped?: boolean
} & (
  | {
    /** Complete provider output before the text-only summary projection. */
    rawOutput: ContentBlock[]
    /** Identifies exactly one call through this context's `ctx.llm.stream()`. */
    llmStreamCall: true
  }
  | {
    /** Optional complete output from an unmarked template, remote, or other summarizer. */
    rawOutput?: ContentBlock[]
    /** An unmarked result does not identify a call through this context's LLM seam. */
    llmStreamCall?: never
  }
)

/** Structural token-meter face used to price the replayed input without an injected dependency. */
interface MeterFace {
  estimateMessage(message: Message): number
}

/**
 * Resolve the route the summarizer call is dispatched to: the configured pair,
 * then the latest durable routed request, then the agent options. Exposed so
 * the engine can resolve the same target's window for input framing.
 * @param config - resolved backend configuration (with the seat route applied, when any).
 * @param agent - supplies routed-model history and fallback options.
 * @returns the concrete provider/model route, or `undefined` when none exists.
 */
export function resolveSummarizationTarget(
  config: Pick<SummaryConfig, 'summarizationProvider' | 'summarizationModel'>,
  agent: Agent,
): { provider: string; model: string } | undefined {
  const latest = agent.session.requestHeader()?.config
  const configured = config.summarizationProvider.length === 0
    ? undefined
    : { provider: config.summarizationProvider, model: config.summarizationModel }
  const agentTarget = agent.options.provider !== undefined
    && agent.options.provider.length > 0
    && agent.options.model !== undefined
    && agent.options.model.length > 0
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined
  return configured ?? latest ?? agentTarget
}

/** Price one replayed message under the token meter's fixed estimator, or a local fallback. */
function replayPrice(ctx: Context, message: Message): number {
  const meter = ctx.get('tokenMeter') as MeterFace | undefined
  return meter?.estimateMessage(message) ?? Math.ceil(JSON.stringify(message.content).length / 4) + 4
}

/**
 * Cap a replayed conversation to the summariser's input budget by dropping the
 * oldest region messages, keeping the system head and the newest messages.
 * A single message larger than the whole budget cannot be split here; it stays
 * whole and relies on the output-cap guard and, on failure, the mechanical
 * omission fallback (the doc 66 L4 spill for one oversized message is future
 * work).
 */
function clipReplayToBudget(
  ctx: Context,
  messages: readonly Message[],
  fixedTokens: number,
  budgetTokens: number,
): { messages: readonly Message[]; windowClipped: boolean } {
  let total = fixedTokens
  for (const message of messages) total += replayPrice(ctx, message)
  if (total <= budgetTokens) return { messages, windowClipped: false }

  // The system head stays pinned: it is the conversation's identity and the
  // anchor the region's newer messages are read against.
  // oxlint-disable-next-line typescript/no-non-null-assertion -- index 0 exists when the branch can run.
  const head = messages[0]?.role === 'system' ? messages[0]! : undefined
  const firstRegion = head === undefined ? 0 : 1
  const kept: Message[] = []
  let spent = head === undefined ? fixedTokens : fixedTokens + replayPrice(ctx, head)
  for (let index = messages.length - 1; index >= firstRegion; index -= 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- index is a valid position.
    const message = messages[index]!
    const price = replayPrice(ctx, message)
    if (spent + price > budgetTokens) break
    kept.unshift(message)
    spent += price
  }
  return {
    messages: head === undefined ? kept : [head, ...kept],
    windowClipped: true,
  }
}

/**
 * Run the default cache-reusing `ctx.llm.stream()` summarization call: replay
 * the conversation prefix, then append the compaction instruction as the final
 * user message so the provider's warm prefix cache is reused. When the engine
 * supplies an input budget smaller than the replay (a summariser window
 * narrower than the region, e.g. the seat's model), the oldest region messages
 * are omitted from this call and reported as `windowClipped`.
 * @param ctx - context providing the LLM service.
 * @param config - resolved backend configuration (route, chain, and generation cap).
 * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
 * @param agent - supplies routed-model history, fallback model, and session id.
 * @param signal - optional cancellation forwarded to the adapter.
 * @param framing - optional input budget resolved from the summariser's own window.
 * @returns safe text-only summary blocks and the exact call envelope and output.
 */
export async function summarizeWithLlm(
  ctx: Context,
  config: SummaryConfig,
  input: SummarizationInput,
  agent: Agent,
  signal?: AbortSignal,
  framing?: SummarizationFraming,
): Promise<SummaryResult> {
  const target = resolveSummarizationTarget(config, agent)
  if (target === undefined) {
    throw new Error(
      'no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields',
    )
  }

  const instruction: RequestUserInput = deepFreeze({
    role: 'user',
    content: [{ type: 'text', text: COMPACTION_INSTRUCTION }],
  })
  // Text-block price under the meter's fixed estimator (ceil(chars / 4) plus
  // block and role framing), computed locally because the instruction is a
  // request-only input without a Message identity.
  const fixedTokens = Math.ceil(COMPACTION_INSTRUCTION.length / 4) + 8
    + Math.ceil(JSON.stringify(input.tools ?? []).length / 4) + 4
  const budget = framing?.inputBudgetTokens
  const replay = budget === undefined || budget <= 0
    ? { messages: input.messages, windowClipped: false }
    : clipReplayToBudget(ctx, input.messages, fixedTokens, budget)

  const assembler = new BlockAssembler()
  const messages: RequestMessage[] = [...replay.messages, instruction]
  const options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    ...config.summarizationChain === undefined ? {} : { chain: config.summarizationChain },
    messages,
    toolHistory: agent.session.toolHistory(),
    ...input.tools === undefined ? {} : { tools: [...input.tools] },
    maxTokens: config.maxTokens,
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...signal === undefined ? {} : { signal },
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error

  const rawOutput = assembler.blocks()
  const summary = summaryText(rawOutput)
  if (!summary.some(block => block.text.trim().length > 0)) {
    throw new Error('summarization produced no text summary content')
  }
  return {
    summary,
    rawOutput,
    llmStreamCall: true,
    provider: options.provider,
    model: options.model,
    maxTokens: config.maxTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
    ...(replay.windowClipped ? { windowClipped: true } : {}),
  }
}

/**
 * Wrap raw summary blocks in the durable checkpoint framing, optionally with a
 * code-assembled coverage note (the window-capped summary documents which
 * seqs it did not condense and how to retrieve them).
 * @param summary - safe text-only model output.
 * @param coverageNote - deterministic note appended inside the checkpoint, when present.
 * @returns content for the synthesized replacement user message.
 */
export function frameSummary(summary: readonly ContentBlock[], coverageNote?: string): ContentBlock[] {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    ...(coverageNote === undefined ? [] : [{ type: 'text' as const, text: `\n[compaction coverage] ${coverageNote}` }]),
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]
}

/**
 * Frame the deterministic, model-free omission stub that replaces the oldest
 * part of a span whose summary failed. It points at the session log and the
 * recall tools so every shadowed byte stays reachable.
 * @param start - first shadowed surface seq.
 * @param end - last shadowed surface seq.
 * @param count - number of shadowed surface nodes.
 * @returns content for the synthesized replacement user message.
 */
export function frameMechanicalOmission(
  start: SessionSeq,
  end: SessionSeq,
  count: number,
): ContentBlock[] {
  return [{
    type: 'text',
    text: `${OMISSION_PREAMBLE}\n\n<compacted-omission>\nRemoved surface seqs ${start}–${end} (${count} messages).\n</compacted-omission>`,
  }]
}

/** Map a terminal summarization finish to its fail-closed error. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      return new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    }
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/** Reject visual output and keep only text before synthesizing a user message. */
function summaryText(
  blocks: readonly ContentBlock[],
): Array<Extract<ContentBlock, { type: 'text' }>> {
  if (contentHasImage(blocks)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
}
