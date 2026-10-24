/**
 * Default one-shot summarization, window-aware input framing, deterministic
 * mechanical omission framing, and durable checkpoint framing.
 *
 * @module @deepseek-ai/dsh-compaction-basic/summarizer
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  contentHasImage,
  BlockAssembler,
  errorChain,
  IMAGE_OFFLOAD_REQUIRED_CODE,
  LlmError,
  projectImagesForTextModel,
} from '@deepseek-ai/dsh-llm'
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

/**
 * Bounded, durable cause of the summarization failure that forced the
 * mechanical fallback. Mirrors the `compaction/summary` payload field of the
 * same name, so the recorded failure has one vocabulary.
 */
export interface SummarizationFailure {
  /** Stable failure class: the error's own `code` when present, else its constructor name. */
  readonly code: string
  /** Rendered failure message with its cause chain, truncated to a durable audit length. */
  readonly message: string
}

/** Durable audit bound for one recorded summarization-failure message. */
const SUMMARIZATION_FAILURE_MESSAGE_MAX_CHARS = 500

/**
 * Classify one thrown summarization failure for the durable record. The own
 * `code` data property wins when present — `LlmError`/`HarnessError` codes and
 * the plain `MAX_TOKENS` classification — because it is the stable
 * machine-routable class; otherwise the constructor name, or `UNKNOWN` for a
 * non-Error throw. Reading the descriptor cannot invoke a hostile accessor, so
 * recording the failure can never mask it.
 * @param error - value thrown by the summarizer or the shrink guard.
 * @returns the bounded code and message recorded on the summary event.
 */
export function summarizationFailureCause(error: unknown): SummarizationFailure {
  let code: string | undefined
  if (error instanceof Error) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
      if (descriptor !== undefined && 'value' in descriptor
        && typeof descriptor.value === 'string' && descriptor.value.length > 0) {
        code = descriptor.value
      }
    } catch (_hostileCodeAccessor) {
      // The constructor name below still classifies the failure.
    }
  }
  const name = error instanceof Error && error.name.length > 0 ? error.name : undefined
  const message = errorChain(error)
  return {
    code: code ?? name ?? 'UNKNOWN',
    message: message.length <= SUMMARIZATION_FAILURE_MESSAGE_MAX_CHARS
      ? message
      : `${message.slice(0, SUMMARIZATION_FAILURE_MESSAGE_MAX_CHARS - 1)}…`,
  }
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
  '- [open questions, in-flight rationale, and transient data needed to continue; durable items belong in Durable Facts]',
  '',
  '## Durable Facts',
  '- [decision|constraint|requirement|fact] [one self-contained sentence a future session in this workspace needs: a decision with its reason, a constraint, an explicit user requirement or preference, or an exact path / identifier / command / config value. At most 12 items, each under 300 characters. Write "(none)" when nothing qualifies.]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Durable Facts must stay true beyond the current task and make sense without this conversation (no "this", "above", "the current file"). Never include credentials, tokens, keys, passwords, or personal data.',
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
  'This is an automatically generated omission notice. No model summary was available, so the oldest part of an earlier conversation span was removed from the live context to keep the session within its context budget. The complete transcript is preserved in the session log.'

/**
 * Recovery sentence appended to {@link OMISSION_PREAMBLE} only when the
 * compacting agent can actually call the recall tools; a surface without them
 * is never told to use a tool it does not have.
 */
const OMISSION_RECALL_SENTENCE =
  'Recover anything you need from the removed span with session_event_search (keywords), session_event_read (seq), or session_search.'

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
  /** The derived system head, when present, then the pinned leading surface messages, then the shadowed region in surface order. */
  readonly messages: readonly Message[]
  /**
   * Length of the pinned leading-message run directly after the optional
   * system head (surface nodes the compaction keeps verbatim). The window cap
   * keeps these messages together with the head and only clips region
   * messages, so a cached prefix survives even an unusually large pin.
   * `0`/absent replays exactly the pre-pin shape.
   */
  readonly leadingCount?: number
  /**
   * Durable seqs of the region messages, parallel to the tail of `messages`
   * after the optional system head and the pinned leading messages. The engine
   * replays a subset when the summariser window clips the oldest region
   * messages, so recovery needs the exact seqs the failed request carried —
   * not the whole selected span.
   */
  readonly regionSeqs?: readonly SessionSeq[]
}

/** Optional framing supplied by the engine after it resolves the summariser window. */
export interface SummarizationFraming {
  /**
   * Input-token budget of the summariser's own context window, after the
   * output reservation. When the replay exceeds it, the oldest region messages
   * are left out of this call and the durable checkpoint records the gap.
   */
  readonly inputBudgetTokens?: number
  /**
   * The budget is a conservative stand-in because the summariser's own context
   * window (or its metadata) could not be resolved. A clipped replay is then
   * reported as a conservative clip, so the checkpoint note states the real
   * reason instead of implying a known window.
   */
  readonly unknownWindow?: boolean
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
  /**
   * The cap was the conservative unknown-window budget rather than a resolved
   * model window; the checkpoint note names that reason.
   */
  conservativeWindowClip?: boolean
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

/**
 * An `IMAGE_OFFLOAD_REQUIRED` failure from a summarization replay that carries
 * the durable seqs of the messages the failed request actually carried. The
 * compaction recovery passes these to the image-offload waterfall so the
 * offloaded occurrences match the request's own order: a window-clipped replay
 * must not offload images from messages it never sent, or the retry repeats the
 * same refusal.
 */
export class SummarizationReplayError extends LlmError {
  /** Durable seqs of the replayed region messages, ascending by request order. */
  readonly replayedSourceSeqs: readonly SessionSeq[]

  /**
   * @param error - the provider refusal that ended the replay.
   * @param replayedSourceSeqs - durable seqs of the messages the failed request carried.
   */
  constructor(error: LlmError, replayedSourceSeqs: readonly SessionSeq[]) {
    super(error.message, error.code, {
      ...error.failure.status === undefined ? {} : { status: error.failure.status },
      ...error.failure.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: error.failure.providerRetryAfterMs },
      ...error.failure.requestId === undefined ? {} : { requestId: error.failure.requestId },
      ...error.failure.provider === undefined ? {} : { provider: error.failure.provider },
      ...error.failure.model === undefined ? {} : { model: error.failure.model },
      ...error.failure.offloadImages === undefined ? {} : { offloadImages: error.failure.offloadImages },
      cause: error,
    })
    this.replayedSourceSeqs = replayedSourceSeqs
  }
}

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
  regionSeqs: readonly SessionSeq[] | undefined,
  leadingCount: number,
  fixedTokens: number,
  budgetTokens: number,
): { messages: readonly Message[]; regionSeqs: readonly SessionSeq[] | undefined; windowClipped: boolean } {
  let total = fixedTokens
  for (const message of messages) total += replayPrice(ctx, message)
  if (total <= budgetTokens) return { messages, regionSeqs, windowClipped: false }

  // The system head stays pinned: it is the conversation's identity and the
  // anchor the region's newer messages are read against. The leading run the
  // range keeps verbatim is pinned with it for the same prefix-cache reason;
  // only region messages are ever dropped here.
  const head = messages[0]?.role === 'system' ? messages[0] : undefined
  const firstLeading = head === undefined ? 0 : 1
  const firstRegion = Math.min(messages.length, firstLeading + Math.max(0, leadingCount))
  const leading = messages.slice(firstLeading, firstRegion)
  const kept: Message[] = []
  const keptSeqs: SessionSeq[] = []
  let spent = fixedTokens
  if (head !== undefined) spent += replayPrice(ctx, head)
  for (const message of leading) spent += replayPrice(ctx, message)
  for (let index = messages.length - 1; index >= firstRegion; index -= 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- index is a valid position.
    const message = messages[index]!
    const price = replayPrice(ctx, message)
    if (spent + price > budgetTokens) break
    kept.unshift(message)
    // oxlint-disable-next-line typescript/no-non-null-assertion -- regionSeqs parallels the region tail.
    if (regionSeqs !== undefined) keptSeqs.unshift(regionSeqs[index - firstRegion]!)
    spent += price
  }
  return {
    messages: [...(head === undefined ? [] : [head]), ...leading, ...kept],
    regionSeqs: regionSeqs === undefined ? undefined : keptSeqs,
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
    ? { messages: input.messages, regionSeqs: input.regionSeqs, windowClipped: false }
    : clipReplayToBudget(
      ctx,
      input.messages,
      input.regionSeqs,
      input.leadingCount ?? 0,
      fixedTokens,
      budget,
    )

  const dispatch = async (
    replayMessages: readonly Message[],
  ): Promise<{ rawOutput: ContentBlock[]; usage?: TokenUsage; provider: string; model: string }> => {
    const assembler = new BlockAssembler()
    const messages: RequestMessage[] = [...replayMessages, instruction]
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
    // A `llm/stream` listener may have rerouted the one-shot call; the
    // dispatched pair, not the requested one, is what the checkpoint records.
    return {
      rawOutput: assembler.blocks(),
      provider: options.provider,
      model: options.model,
      ...assembler.usage === undefined ? {} : { usage: assembler.usage },
    }
  }

  const replayHasImages = replay.messages.some(message => contentHasImage(message.content))
  let dispatched: { rawOutput: ContentBlock[]; usage?: TokenUsage; provider: string; model: string }
  try {
    dispatched = await dispatch(replay.messages)
  } catch (error: unknown) {
    // An image-cap refusal is recoverable only against the request the provider
    // actually saw. Carry the replayed seqs so offload recovery names those
    // messages, not the clipped-away oldest ones.
    if (error instanceof LlmError
      && error.code === IMAGE_OFFLOAD_REQUIRED_CODE
      && replay.regionSeqs !== undefined
      && replay.regionSeqs.length > 0) {
      throw new SummarizationReplayError(error, replay.regionSeqs)
    }
    // A route refusing media is a request-level fact, never a summariser
    // failure: retry once with every image occurrence replaced by its stable
    // text placeholder so a text-only summariser still condenses the span.
    if (!replayHasImages || !(error instanceof LlmError) || error.code !== 'UNSUPPORTED_CONTENT') throw error
    dispatched = await dispatch(projectImagesForTextModel(replay.messages))
  }

  const summary = summaryText(dispatched.rawOutput)
  if (!summary.some(block => block.text.trim().length > 0)) {
    throw new Error('summarization produced no text summary content')
  }
  return {
    summary,
    rawOutput: dispatched.rawOutput,
    llmStreamCall: true,
    provider: dispatched.provider,
    model: dispatched.model,
    maxTokens: config.maxTokens,
    ...dispatched.usage === undefined ? {} : { usage: dispatched.usage },
    ...(replay.windowClipped ? { windowClipped: true } : {}),
    ...(replay.windowClipped && framing?.unknownWindow === true
      ? { conservativeWindowClip: true }
      : {}),
  }
}

/**
 * Wrap raw summary blocks in the durable checkpoint framing, optionally with a
 * code-assembled coverage note (the window-capped summary documents which
 * seqs it did not condense and how to retrieve them) and a deployment recall
 * footer (appended after the close tag only when its tools resolve).
 * @param summary - safe text-only model output.
 * @param coverageNote - deterministic note appended inside the checkpoint, when present.
 * @param recallFooter - deployment recall guidance appended after the close tag, when present.
 * @returns content for the synthesized replacement user message.
 */
export function frameSummary(
  summary: readonly ContentBlock[],
  coverageNote?: string,
  recallFooter?: string,
): ContentBlock[] {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    ...(coverageNote === undefined ? [] : [{ type: 'text' as const, text: `\n[compaction coverage] ${coverageNote}` }]),
    { type: 'text', text: SUMMARY_CLOSE_TAG },
    ...(recallFooter === undefined ? [] : [{ type: 'text' as const, text: recallFooter }]),
  ]
}

/**
 * Frame the deterministic, model-free omission stub that replaces the oldest
 * part of a span whose summary failed. It points at the session log and — only
 * when the compacting agent can actually call them — the recall tools, so
 * every shadowed byte stays reachable.
 * @param start - first shadowed surface seq.
 * @param end - last shadowed surface seq.
 * @param count - number of shadowed surface nodes.
 * @param recallTools - whether `session_event_search` and `session_event_read` resolve in this scope.
 * @returns content for the synthesized replacement user message.
 */
export function frameMechanicalOmission(
  start: SessionSeq,
  end: SessionSeq,
  count: number,
  recallTools = true,
): ContentBlock[] {
  const preamble = recallTools ? `${OMISSION_PREAMBLE} ${OMISSION_RECALL_SENTENCE}` : OMISSION_PREAMBLE
  return [{
    type: 'text',
    text: `${preamble}\n\n<compacted-omission>\nRemoved surface seqs ${start}–${end} (${count} messages).\n</compacted-omission>`,
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
