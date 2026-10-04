/**
 * enpoi-capabilities — Root-side advisory recommendation for forwarded child asks.
 *
 * When a delegated child's ask is forwarded onto the root session's approval
 * card, the ROOT session's default model answers ONE bounded, cheap question
 * (the keeper/oracle one-shot seam family: `llm.stream` plus a tight
 * `deadline`): given the ask, its provenance, the rails verdict, and the
 * child's workspace relation, return one short sentence plus an advisory
 * suggestion (`allow` / `reject` / `allow-once`). On an interactive card the
 * answer is PRESENTATION ONLY — the card renders it as its own line and the
 * human's answer resolves the ask. In Full access (no card) the SAME call is
 * the parent's judgement and its suggestion IS applied in the operator's place
 * (forwarding.ts); the prompt says so when `applied` is set.
 *
 * Bounds: the call is deadline-bounded ({@link RECOMMENDATION_TIMEOUT_MS}),
 * caps its output tokens, and answers `undefined` on ANY failure (error,
 * timeout, cut, unparseable output). The forwarder then keeps its derived
 * heuristic line, so the card never blocks, the asking child never hangs, and
 * the card is never empty.
 *
 * @module
 */

import {
  BlockAssembler, createUserMessage,
  type ContextFormed, type GenerateOptions, type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { deadline } from '@deepseek-ai/dsh-timeout'
import type { AskDecision, ForwardingOrigin, ModelRecommendation, RailHit, RecommendationSuggestion } from './forwarding'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Enpoi root-side approval recommendation one-shot requests. */
    'enpoi-recommendation': { kind: 'enpoi-recommendation' } & ContextFormed
  }
}

/** Hard bound on one recommendation call; beyond it the derived line is kept. */
export const RECOMMENDATION_TIMEOUT_MS = 6000

/** Output cap for the one-sentence answer (this is a bounded side call). */
export const RECOMMENDATION_MAX_TOKENS = 96

/** Longest recommendation line shown on the card (longer answers are clipped). */
export const RECOMMENDATION_MAX_CHARS = 240

/** Longest serialized argument payload sent to the reasoner. */
const ARGUMENTS_MAX_CHARS = 600

/** The advisory suggestion vocabulary; every parsed answer is validated against it. */
const SUGGESTIONS: readonly RecommendationSuggestion[] = ['allow', 'reject', 'allow-once']

/** The reasoner's only instructions: judge from the facts, answer one JSON object. */
const SYSTEM_PROMPT = [
  'You advise the root session on one approval request forwarded from a delegated subagent.',
  'Answer with ONE JSON object and nothing else:',
  '{"text": "<one short sentence, at most 160 characters>", "suggestion": "allow" | "reject" | "allow-once"}',
  'Judge only from the facts given. "allow-once" = the action looks safe to run once; "allow" = safe and repeatable; "reject" = risky.',
  'Your answer is advisory: the human answers the card. Never output code, commands, or tool calls.',
].join('\n')

/** Appended when the answer is applied as the decision (Full access, no card). */
const APPLIED_PROMPT = [
  'This request comes from a root session in Full access: there is no human card, and your suggestion is APPLIED as the decision in the operator\'s place.',
  'Judge accordingly: reject anything you are not certain is safe.',
].join('\n')

/** The facts one root-side recommendation call is made from. */
export interface RecommendationAsk {
  readonly toolName: string
  readonly args?: Record<string, unknown> | undefined
  /** Provenance: the child's label, depth, and session ids. */
  readonly origin: ForwardingOrigin
  /** The child workspace's relation to the root's, as one line. */
  readonly workspaceRelation: string
  /** The rails verdict: absent means no never-approvable class matched. */
  readonly rail?: RailHit | undefined
  /** The ask the child's own policy produced (why it asked + matched rule). */
  readonly decision: AskDecision
  /**
   * True when this answer is APPLIED as the decision (the Full-access parent
   * judgement) rather than rendered as card advice; the prompt says so.
   */
  readonly applied?: boolean | undefined
}

/** The host-owned model call the one recommendation attempt runs through. */
export interface RecommendationModelCall {
  /** The `llm` service's stream, structurally narrow. */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  /** The route the root session's default model answers on. */
  provider: string
  model: string
  /** Deadline for this call; defaults to {@link RECOMMENDATION_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Upstream cancellation (the child's own tool signal), fused into the deadline. */
  signal?: AbortSignal | undefined
  /**
   * Quiet diagnostic for one missed attempt (error, timeout, cut, unparseable).
   * The return value stays `undefined` either way, so the caller keeps the
   * derived line; this exists so the failure is nameable instead of silent.
   */
  onMiss?(reason: string): void
}

/** Truncated session id for the compact prompt (never a full uuid). */
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

/** One argument payload bounded for the prompt; lossless JSON or a placeholder. */
function boundedArguments(args: Record<string, unknown> | undefined): string {
  if (args === undefined) return '(none)'
  let serialized: string
  try {
    serialized = JSON.stringify(args) ?? '(unserializable)'
  } catch {
    serialized = '(unserializable)'
  }
  return serialized.length > ARGUMENTS_MAX_CHARS ? `${serialized.slice(0, ARGUMENTS_MAX_CHARS - 1)}…` : serialized
}

/**
 * Build the one-shot prompt for a forwarded ask: the ask, its provenance, the
 * rails verdict, and the child's workspace relation — nothing else.
 * @param ask - the forwarded ask's facts.
 * @returns the system instruction and the single user message.
 */
export function buildRecommendationPrompt(ask: RecommendationAsk): { system: string; user: string } {
  const rail = ask.rail === undefined
    ? 'no never-approvable class matched'
    : `matched ${ask.rail.rail} (${ask.rail.evidence})`
  const user = [
    'Forwarded child ask',
    `tool: ${ask.toolName}`,
    `arguments: ${boundedArguments(ask.args)}`,
    `child: ${ask.origin.label} (depth ${ask.origin.depth}, session ${shortId(ask.origin.childSessionId)})`,
    `why it asked: ${ask.decision.reason}`,
    `matched rule: ${ask.decision.source}`,
    `rails verdict: ${rail}`,
    `workspace: ${ask.workspaceRelation}`,
  ].join('\n')
  return { system: ask.applied === true ? `${SYSTEM_PROMPT}\n${APPLIED_PROMPT}` : SYSTEM_PROMPT, user }
}

/**
 * Parse one model answer into the advisory line. Accepts a JSON object
 * (optionally inside prose or a code fence) whose `text` is a non-empty
 * string; `suggestion` is kept only when it is one of the closed vocabulary.
 * Anything else returns `undefined`, which makes the caller keep the derived
 * line — model output is untrusted presentation text.
 * @param raw - the model's raw text output.
 * @returns the validated recommendation, or `undefined` when unusable.
 */
export function parseRecommendationAnswer(raw: string): ModelRecommendation | undefined {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as { text?: unknown; suggestion?: unknown }
  if (typeof record.text !== 'string') return undefined
  const text = record.text.replace(/\s+/g, ' ').trim()
  if (text === '') return undefined
  const clipped = text.length > RECOMMENDATION_MAX_CHARS ? `${text.slice(0, RECOMMENDATION_MAX_CHARS - 1)}…` : text
  const candidate = typeof record.suggestion === 'string' ? record.suggestion.trim().toLowerCase() : undefined
  const suggestion = candidate !== undefined && (SUGGESTIONS as readonly string[]).includes(candidate)
    ? candidate as RecommendationSuggestion
    : undefined
  return { text: clipped, ...suggestion !== undefined ? { suggestion } : {} }
}

/**
 * Run ONE bounded root-side recommendation call. Returns `undefined` on any
 * miss — provider error, timeout, aborted signal, non-`stop` finish, or
 * unparseable output — so the caller always falls back to the derived line.
 * @param ask - the forwarded ask's facts.
 * @param call - the host-owned stream and route plus the deadline.
 * @returns the parsed advisory recommendation, or `undefined`.
 */
export async function requestRecommendation(
  ask: RecommendationAsk,
  call: RecommendationModelCall,
): Promise<ModelRecommendation | undefined> {
  const prompt = buildRecommendationPrompt(ask)
  using callDeadline = deadline(call.signal, call.timeoutMs ?? RECOMMENDATION_TIMEOUT_MS, 'ENPOI_FORWARDED_RECOMMENDATION')
  const assembler = new BlockAssembler()
  try {
    for await (const chunk of call.stream({
      provider: call.provider,
      model: call.model,
      messages: [createUserMessage({
        content: [{ type: 'text', text: prompt.user }],
        source: { kind: 'enpoi-recommendation' },
      })],
      system: prompt.system,
      maxTokens: RECOMMENDATION_MAX_TOKENS,
      temperature: 0,
      signal: callDeadline.signal,
    })) {
      callDeadline.signal.throwIfAborted()
      assembler.push(chunk)
    }
    callDeadline.signal.throwIfAborted()
  } catch (error) {
    call.onMiss?.(error instanceof Error ? error.message : String(error))
    return undefined
  }
  if (assembler.finish.kind !== 'stop') {
    call.onMiss?.(`finish ${assembler.finish.kind}`)
    return undefined
  }
  const blocks = assembler.blocks()
  const text = blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
    .trim()
  const parsed = parseRecommendationAnswer(text)
  if (parsed === undefined) call.onMiss?.(`unparseable answer: ${text.slice(0, 120)}`)
  return parsed
}
