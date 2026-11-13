/**
 * Projection of the durable conversation surface into the public-only replay
 * the summariser may read, plus the source index that distinguishes an
 * operator instruction from generated context and evidence.
 *
 * Durable events are never mutated: the projection returns the original
 * `Message` objects for every clean surface node, so a cached request prefix
 * stays byte-identical. Only messages that carry private reasoning or an
 * affected tool batch are rewritten, and then only their request projection
 * changes.
 *
 * @module @deepseek-ai/dsh-compaction-basic/replay
 */

import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {
  AssistantMessage,
  ContentBlock,
  Message,
  ModelMessageSource,
  ToolCallBlock,
  ToolCallId,
  ToolResultMessage,
  UserMessage,
} from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SummarizationSourceRef } from './summarizer.ts'

/** Labels the deterministic public evidence written in place of a tool protocol. */
const TOOL_CALL_LABEL = '[tool call evidence]'
const TOOL_RESULT_LABEL = '[tool result evidence]'

/** Longest source-kind name rendered in the source index. */
const SOURCE_KIND_MAX_CHARS = 48

/**
 * The summariser replay cannot safely represent one surface node as public
 * content. The automatic transaction records its deterministic omission
 * fallback; a manual transaction fails loudly rather than dropping facts.
 */
export class SummarizationReplayProjectionError extends Error {
  /**
   * @param message - why the node cannot be represented as public content.
   */
  constructor(message: string) {
    super(message)
    this.name = 'SummarizationReplayProjectionError'
  }
}

/** The public conversation projection and the source refs parallel to it. */
export interface PublicSummarizationReplay {
  /** Original messages for clean nodes, rewritten messages for affected nodes. */
  readonly messages: readonly Message[]
  /** Pinned leading messages kept verbatim; omitted when the run is empty. */
  readonly leadingCount?: number
  /** Durable seqs of the projected region messages, parallel to the message tail. */
  readonly regionSeqs: readonly SessionSeq[]
  /**
   * Source attribution for every projected message, in replay order. Omitted when every
   * node's role already states its authority (system, human user, public
   * assistant, tool result), so a clean replay keeps its original input shape.
   */
  readonly sourceIndex?: readonly SummarizationSourceRef[]
}

/** One derived surface node with its durable event and request projection. */
interface ReplayEntry {
  readonly seq: SessionSeq
  readonly event: SessionEvent
  readonly message: Message
}

/** How one assistant node was projected into public content. */
type AssistantProjection = 'clean' | 'reasoning-omitted' | 'tool-batch-public'

/** How one tool-result node was projected into public content. */
type ToolProjection = 'clean' | 'public-evidence'

/**
 * Find private reasoning anywhere in one content value, including a reasoning
 * block nested in a merge-extensible plugin block. The scan is bounded by the
 * replayed message content and never mutates it.
 * @param value - content block, array, or nested producer value.
 * @returns whether a reasoning block occurs at any depth.
 */
export function containsPrivateReasoning(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPrivateReasoning)
  if (typeof value !== 'object' || value === null) return false
  if ('type' in value && value.type === 'reasoning') return true
  return Object.values(value).some(containsPrivateReasoning)
}

/**
 * Reject private reasoning in a node the projection otherwise passes through
 * verbatim. No summariser route may receive hidden reasoning, including from a
 * user, developer, system, or tool-role message.
 * @param message - message being projected unchanged.
 */
function assertNoPrivateReasoning(message: Message): void {
  if (containsPrivateReasoning(message.content)) {
    throw new SummarizationReplayProjectionError(
      `${message.role} message carries private reasoning; refusing to replay it to the summariser`,
    )
  }
}

/** One node's authority label, its selection class, and whether its role alone states it. */
interface AuthorityLabel {
  readonly text: string
  readonly conventional: boolean
  readonly authorityClass: SummarizationSourceRef['authorityClass']
}

/** One tool call replayed by the region, with the batch's projection decision. */
interface CallSite {
  readonly name: string
  readonly affected: boolean
}

/**
 * Derive one surface node's message and durable event.
 * @param session - session supplying the durable event.
 * @param seq - current surface seq.
 * @returns the entry, or `undefined` when the node projects no message.
 */
function deriveEntry(session: Session, seq: SessionSeq): ReplayEntry | undefined {
  // Existing Session history read; migration deferred.
  // oxlint-disable-next-line typescript/no-deprecated
  const event = session.eventAt(seq)
  /* v8 ignore next -- surface seqs are current log indexes; a missing event is a stale selection. */
  if (event === undefined) return undefined
  const message = session.deriveEventMessage(event)
  return message === null ? undefined : { seq, event, message }
}

/** Bound one producer-supplied source kind for the model-visible index. */
function boundedSourceKind(kind: string): string {
  return kind.length <= SOURCE_KIND_MAX_CHARS
    ? kind
    : `${kind.slice(0, SOURCE_KIND_MAX_CHARS - 1)}…`
}

/** Read an optional context form without assuming every source declares one. */
function sourceForm(source: object): string | undefined {
  if (!('form' in source)) return undefined
  const form: unknown = source.form
  /* v8 ignore next -- ContextFormed declares form as a string; a non-string is malformed durable data. */
  return typeof form === 'string' ? form : undefined
}

/** Whether one assistant content block is private model reasoning. */
function isReasoning(block: ContentBlock): boolean {
  return block.type === 'reasoning'
}

/** Whether one assistant content block is a tool invocation. */
function isToolCall(block: ContentBlock): block is ToolCallBlock {
  return block.type === 'tool-call'
}

/**
 * Classify one surface node's authority from its durable event source fields.
 * Only the actual human discriminator grants operator authority; every
 * generated, peer, checkpoint, assistant, and tool source is derived evidence.
 * @param event - durable event that produced the replayed message.
 * @param assistant - how an assistant node was projected, when it is one.
 * @param tool - how a tool-result node was projected, when it is one.
 * @returns the model-visible label and whether the role already states it.
 */
function classifyAuthority(
  event: SessionEvent,
  assistant: AssistantProjection = 'clean',
  tool: ToolProjection = 'clean',
  head = false,
): AuthorityLabel {
  switch (event.type) {
    case 'system/message':
      return head
        ? { text: 'system prompt (instruction; not an operator message)', conventional: true, authorityClass: 'public' }
        : {
          text: 'system message outside the head (derived; actor unverified)',
          conventional: false,
          authorityClass: 'derived',
        }
    case 'developer/message':
      return {
        text: 'developer tool-protocol message (derived; not an operator anchor)',
        conventional: true,
        authorityClass: 'derived',
      }
    case 'user/message': {
      const source = event.data.source
      if (source.kind === 'compact-checkpoint') {
        return {
          text: 'generated compaction checkpoint (derived; never an operator anchor)',
          conventional: false,
          authorityClass: 'derived',
        }
      }
      if (source.kind === 'user') {
        if (source.participant?.kind === 'peer') {
          return {
            text: 'peer agent message (derived; never an operator anchor)',
            conventional: false,
            authorityClass: 'derived',
          }
        }
        if (source.participant?.kind === 'human') {
          return {
            text: 'human operator instruction',
            conventional: false,
            authorityClass: 'operator',
          }
        }
        return {
          text: 'user-role message, actor unverified (task input, not a standing directive)',
          conventional: true,
          authorityClass: 'unverified-user',
        }
      }
      const form = sourceForm(source)
      const formText = form === undefined ? '' : `, form ${form}`
      return {
        text: `generated user-role context from "${boundedSourceKind(source.kind)}"${formText} (derived; never an operator anchor)`,
        conventional: false,
        authorityClass: 'derived',
      }
    }
    case 'assistant/message':
      switch (assistant) {
        case 'clean':
          return { text: 'public assistant output', conventional: true, authorityClass: 'public' }
        case 'reasoning-omitted':
          return {
            text: 'public assistant output (private reasoning omitted; never an operator anchor)',
            conventional: false,
            authorityClass: 'derived',
          }
        case 'tool-batch-public':
          return {
            text: 'public assistant output and tool-call arguments projected as public evidence (private reasoning omitted or incomplete batch; never an operator anchor)',
            conventional: false,
            authorityClass: 'derived',
          }
      }
    case 'tool/result':
      switch (tool) {
        case 'clean':
          return { text: 'tool result evidence', conventional: true, authorityClass: 'public' }
        case 'public-evidence':
          return {
            text: 'tool result evidence projected as user-role public evidence (never an operator anchor)',
            conventional: false,
            authorityClass: 'derived',
          }
      }
    /* v8 ignore next 5 -- only message-producing events reach classification. */
    default:
      return {
        text: `message from session event "${boundedSourceKind(event.type)}" (source unverified)`,
        conventional: false,
        authorityClass: 'derived',
      }
  }
}

/**
 * Rebuild one assistant message without private reasoning and without its
 * provider replay state, which no longer describes the projected content.
 * @param message - assistant message carrying reasoning.
 * @param content - public content for the replacement.
 * @returns an immutable assistant message with the same route attribution.
 */
function publicAssistant(message: AssistantMessage, content: readonly ContentBlock[]): AssistantMessage {
  const source: Omit<ModelMessageSource, 'kind'> = {
    provider: message.source.provider,
    model: message.source.model,
    ...message.source.chain === undefined ? {} : { chain: message.source.chain },
  }
  return createAssistantMessage({ content, source })
}

/**
 * Validate that one projected message carries only public block kinds the
 * replay can represent. An unknown block fails the projection rather than
 * silently disappearing from the summariser's evidence.
 * @param content - blocks that will replace the original message content.
 * @param owner - message description used in the failure.
 */
function assertPublicBlocks(content: readonly ContentBlock[], owner: string): void {
  for (const block of content) {
    switch (block.type) {
      case 'text':
      case 'image':
      case 'file':
        break
      default:
        throw new SummarizationReplayProjectionError(
          `${owner} carries unsupported ${block.type} content; `
          + 'refusing to drop it from the public replay',
        )
    }
  }
}

/**
 * Preserve one tool result's public content as evidence, never as an
 * instruction and never by dropping an attachment or an unsupported block.
 * @param message - tool result being projected.
 * @returns its content blocks, validated for a user-role evidence message.
 */
function toolEvidenceBlocks(message: ToolResultMessage): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
      case 'image':
      case 'file':
        blocks.push(block)
        break
      default:
        throw new SummarizationReplayProjectionError(
          `tool result ${message.toolCallId} carries unsupported ${block.type} content; `
          + 'refusing to drop it from the public replay',
        )
    }
  }
  return blocks
}

/**
 * Build the public assistant evidence for one affected tool batch: public
 * output stays verbatim, each call becomes labelled argument evidence, and a
 * call with no recorded result is stated instead of silently omitted.
 * @param message - assistant message owning the affected batch.
 * @param calls - the batch's tool calls in content order.
 * @param results - every tool-call id with a replayed result.
 * @returns public content with no reasoning and no native tool-call blocks.
 */
function assistantBatchEvidence(
  message: AssistantMessage,
  calls: readonly ToolCallBlock[],
  results: ReadonlySet<ToolCallId>,
): ContentBlock[] {
  const content: ContentBlock[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'reasoning':
        break
      case 'text':
      case 'image':
      case 'file':
        content.push(block)
        break
      case 'tool-call':
        content.push({
          type: 'text',
          text: `${TOOL_CALL_LABEL} ${block.id} ${block.name}(${block.arguments})`,
        })
        break
      default:
        throw new SummarizationReplayProjectionError(
          `assistant message carries unsupported ${block.type} content; `
          + 'refusing to drop it from the public replay',
        )
    }
  }
  for (const call of calls) {
    if (results.has(call.id)) continue
    content.push({
      type: 'text',
      text: `${TOOL_RESULT_LABEL} ${call.id} (no result recorded in this replay)`,
    })
  }
  return content
}

/**
 * Project one assistant node. A clean node keeps its exact message object so a
 * cached prefix survives; reasoning is removed only from the node that carries
 * it, and a node that also carries tool calls has its entire batch converted to
 * public evidence instead of leaving a native protocol whose signed thinking
 * was removed.
 * @param entry - the assistant surface node.
 * @param calls - its tool calls, when it has any.
 * @param results - every replayed tool-call id with a result.
 * @returns the projected message (or `null` when only private reasoning
 *   existed) and its authority label.
 */
function projectAssistant(
  entry: ReplayEntry,
  calls: readonly ToolCallBlock[],
  results: ReadonlySet<ToolCallId>,
): { message: Message | null; authority: AuthorityLabel } {
  const message = entry.message
  /* v8 ignore next 3 -- the caller dispatches by role. */
  if (message.role !== 'assistant') {
    throw new SummarizationReplayProjectionError('assistant projection received a non-assistant message')
  }
  const hasReasoning = message.content.some(isReasoning)
  const incomplete = calls.some(call => !results.has(call.id))
  if (!hasReasoning && !incomplete) {
    assertNoPrivateReasoning(message)
    return { message, authority: classifyAuthority(entry.event, 'clean') }
  }
  if (calls.length === 0) {
    const content = message.content.filter(block => !isReasoning(block))
    if (content.length === 0) {
      return { message: null, authority: classifyAuthority(entry.event, 'reasoning-omitted') }
    }
    assertPublicBlocks(content, 'assistant message')
    return {
      message: publicAssistant(message, content),
      authority: classifyAuthority(entry.event, 'reasoning-omitted'),
    }
  }
  return {
    message: publicAssistant(message, assistantBatchEvidence(message, calls, results)),
    authority: classifyAuthority(entry.event, 'tool-batch-public'),
  }
}

/**
 * Project one tool-result node. A result belonging to a clean, complete batch
 * keeps its native tool role; a result whose batch was converted, whose call is
 * not replayed, or whose call is missing becomes labelled user-role evidence.
 * @param entry - the tool-result surface node.
 * @param calls - every replayed tool call keyed by id.
 * @param affectedCalls - call ids whose batches were converted to evidence.
 * @returns the projected message and its authority label.
 */
function projectToolResult(
  entry: ReplayEntry,
  calls: ReadonlyMap<ToolCallId, CallSite>,
  affectedCalls: ReadonlySet<ToolCallId>,
): { message: Message | null; authority: AuthorityLabel } {
  const message = entry.message
  /* v8 ignore next 3 -- the caller dispatches by role. */
  if (message.role !== 'tool') {
    throw new SummarizationReplayProjectionError('tool-result projection received a non-tool message')
  }
  const call = calls.get(message.toolCallId)
  if (call !== undefined && !call.affected && !affectedCalls.has(message.toolCallId)) {
    assertNoPrivateReasoning(message)
    return { message, authority: classifyAuthority(entry.event, 'clean', 'clean') }
  }
  const origin = call === undefined
    ? ' (originating call not in this replay)'
    : ` for ${call.name}`
  const outcome = message.isError === true ? ' [error]' : ''
  const evidence: ContentBlock[] = [{
    type: 'text',
    text: `${TOOL_RESULT_LABEL} ${message.toolCallId}${origin}${outcome}`,
  }, ...toolEvidenceBlocks(message)]
  const projected: UserMessage = createUserMessage({ content: evidence, source: message.source })
  return { message: projected, authority: classifyAuthority(entry.event, 'clean', 'public-evidence') }
}

/**
 * Project one surface node into the public replay.
 * @param entry - the node to project.
 * @param calls - every replayed tool call keyed by id.
 * @param results - every replayed tool-call id with a result.
 * @param affectedCalls - call ids whose assistant batch was converted.
 * @returns the projected message and authority label.
 */
function projectEntry(
  entry: ReplayEntry,
  calls: ReadonlyMap<ToolCallId, CallSite>,
  results: ReadonlySet<ToolCallId>,
  affectedCalls: ReadonlySet<ToolCallId>,
  head: boolean,
): { message: Message | null; authority: AuthorityLabel } {
  switch (entry.message.role) {
    case 'assistant': {
      const toolCalls = entry.message.content.filter(isToolCall)
      return projectAssistant(entry, toolCalls, results)
    }
    case 'tool':
      return projectToolResult(entry, calls, affectedCalls)
    case 'system':
    case 'developer':
    case 'user':
      assertNoPrivateReasoning(entry.message)
      return { message: entry.message, authority: classifyAuthority(entry.event, 'clean', 'clean', head) }
    /* v8 ignore next -- MessageRoleMap is closed and every role is handled above. */
    default:
      throw new SummarizationReplayProjectionError('unsupported message role in the summarizer replay')
  }
}

/**
 * Project the system head, pinned leading messages, and selected region into a
 * public-only summariser replay. Clean nodes are returned by reference; only
 * affected nodes are rewritten. The returned `leadingCount` and `regionSeqs`
 * stay parallel to the projected messages after any dropped node.
 * @param session - session supplying durable events and message derivation.
 * @param leadingSeqs - surface seqs between the system head and the region.
 * @param regionSeqs - the selected surface seqs being compacted.
 * @returns public messages, their source refs, and the parallel seqs.
 */
export function projectSummarizationReplay(
  session: Session,
  leadingSeqs: readonly SessionSeq[],
  regionSeqs: readonly SessionSeq[],
): PublicSummarizationReplay {
  const leading = leadingSeqs
    .map(seq => deriveEntry(session, seq))
    .filter((entry): entry is ReplayEntry => entry !== undefined)
  const region = regionSeqs
    .map(seq => deriveEntry(session, seq))
    .filter((entry): entry is ReplayEntry => entry !== undefined)

  const entries = [...leading, ...region]
  const results = new Set<ToolCallId>()
  for (const entry of entries) {
    if (entry.message.role === 'tool') results.add(entry.message.toolCallId)
  }
  const calls = new Map<ToolCallId, CallSite>()
  const affectedCalls = new Set<ToolCallId>()
  for (const entry of entries) {
    if (entry.message.role !== 'assistant') continue
    const hasReasoning = entry.message.content.some(isReasoning)
    const toolCalls = entry.message.content.filter(isToolCall)
    const incomplete = toolCalls.some(call => !results.has(call.id))
    const affected = toolCalls.length > 0 && (hasReasoning || incomplete)
    for (const call of toolCalls) {
      calls.set(call.id, { name: call.name, affected })
      if (affected) affectedCalls.add(call.id)
    }
  }

  // shadowedSeqs are current surface seqs, so the surface has a node 0.
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const headSeq = session.surface.nodes[0]!
  const project = (entries: readonly ReplayEntry[]): {
    entries: { seq: SessionSeq; message: Message; authority: AuthorityLabel }[]
  } => {
    const projected: { seq: SessionSeq; message: Message; authority: AuthorityLabel }[] = []
    for (const entry of entries) {
      const result = projectEntry(entry, calls, results, affectedCalls, entry.seq === headSeq)
      if (result.message !== null) {
        projected.push({ seq: entry.seq, message: result.message, authority: result.authority })
      }
    }
    return { entries: projected }
  }
  const projectedLeading = project(leading)
  const projectedRegion = project(region)

  // shadowedSeqs are current surface seqs, so the surface has a node 0.
  // Existing Session history read; migration deferred.
  // oxlint-disable-next-line typescript/no-non-null-assertion, typescript/no-deprecated
  const head = session.eventAt(session.surface.nodes[0]!)
  const system = head?.type === 'system/message' ? session.deriveEventMessage(head) : null
  if (system !== null) assertNoPrivateReasoning(system)
  const sourceIndex: SummarizationSourceRef[] = []
  if (system !== null && head?.type === 'system/message') {
    const authority = classifyAuthority(head, 'clean', 'clean', true)
    sourceIndex.push({ seq: head.seq, authority: authority.text, authorityClass: authority.authorityClass })
  }
  for (const entry of [...projectedLeading.entries, ...projectedRegion.entries]) {
    sourceIndex.push({
      seq: entry.seq,
      authority: entry.authority.text,
      authorityClass: entry.authority.authorityClass,
    })
  }
  const needsIndex = [...projectedLeading.entries, ...projectedRegion.entries]
    .some(entry => !entry.authority.conventional)
  return {
    messages: [
      ...(system === null ? [] : [system]),
      ...projectedLeading.entries.map(entry => entry.message),
      ...projectedRegion.entries.map(entry => entry.message),
    ],
    ...projectedLeading.entries.length === 0 ? {} : { leadingCount: projectedLeading.entries.length },
    regionSeqs: projectedRegion.entries.map(entry => entry.seq),
    ...needsIndex ? { sourceIndex } : {},
  }
}
