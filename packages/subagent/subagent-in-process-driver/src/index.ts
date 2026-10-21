/**
 * Shared driver for in-process ONE-SHOT subagent providers. The agent factory's
 * creation transaction owns unpublished setup and rollback; after publication
 * the returned AgentHandle is the one quiescent lifecycle owner held by the
 * provider's caller.
 *
 * Continuable children never come through here: the continuation manager
 * composes and drives them directly, so this driver owns exactly one turn with
 * one result.
 *
 * @module @deepseek-ai/dsh-subagent-in-process-driver
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId, SessionLogOffset as SessionLogOffsetType, TurnEndReason } from '@deepseek-ai/dsh-session'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  appendDelegatedPolicyOverrides,
  applyChildComposition,
  assertSubagentMaxDepth,
  captureDelegatedPolicyOverrides,
  childSessionMeta,
  finalAssistantOutput,
  resolveChildAgentOptions,
  resolveChildDepth,
} from '@deepseek-ai/dsh-subagent'
import type {
  ResolvedSubagentStartRequest,
  SubagentDescriptorData,
  SubagentResult,
  SubagentRun,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import {
  attachStructuredRuntime,
  type StructuredAttachment,
} from './structured.ts'

export {
  STRUCTURED_OUTPUT_TOOL,
  STRUCTURED_OUTPUT_INSTRUCTION,
} from './structured.ts'

/** Map a session turn outcome to the subagent seam's terminal vocabulary. */
function toStopReason(reason: TurnEndReason | undefined): SubagentStopReason {
  switch (reason?.kind) {
    case 'completed':
      return 'completed'
    case 'max-tokens':
      return 'max-tokens'
    case 'aborted':
      return 'aborted'
    // A pre-step rejection discarded the claimed prompt: the task was
    // declined, and the caller must not read the run as done.
    case 'blocked':
      return 'refusal'
    case 'error':
    case 'interrupted':
    default:
      return 'error'
  }
}

/**
 * Extra child turns this driver grants after the model's output budget cut a
 * turn off. An output limit truncates one response, not the task: the child
 * keeps its own log, so the next turn continues from what it already wrote.
 * Two is the ceiling because a third truncation means the requested answer does
 * not fit the route's budget at all, and the parent must decide what to drop.
 */
const TRUNCATION_CONTINUATIONS = 2

/** The continuation order appended after a truncated turn. */
const TRUNCATION_CONTINUATION = 'Your previous message was cut off by the output token limit before it finished. '
  + 'Continue from exactly where it stopped: do not restart the task and do not repeat what you already wrote. '
  + 'If the remaining work cannot fit in one response, finish with what matters most and state what is still missing.'

/** Extra inputs the spawn and fork providers supply to the shared driver. */
export interface InProcessRunOptions {
  /** Completed-turn seed for fork, or undefined for a fresh spawn. */
  readonly seed?: readonly SessionEvent[]
}

/** Error used when cancellation wins before the child publication boundary. */
function prePublicationAbort(): Error {
  return new Error('subagent request was aborted before child publication')
}

/** Append one one-shot descriptor inside the child's initial turn before its first request. */
function attachDescriptorAppend(childCtx: Context, descriptor: SubagentDescriptorData): void {
  let appended = false
  childCtx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (!appended && decision.kind === 'enter') {
      appended = true
      agent.session.append('subagent/descriptor', descriptor)
    }
    return decision
  })
}

/**
 * Establish and drive one in-process one-shot child. Fulfillment means the agent
 * is already published in the registry and transfers its turn, cancellation,
 * and disposal work through the returned run. Rejection means the agent
 * factory's unpublished creation transaction reached quiescence without
 * publishing a child. Every start appends its resolved descriptor inside the
 * child's initial turn.
 * @param request - the trusted typed start request, including its required signal.
 * @param options - the optional fork seed.
 * @returns a published holder-owned run.
 */
export async function startInProcessRun(
  request: ResolvedSubagentStartRequest,
  options: InProcessRunOptions,
): Promise<SubagentRun> {
  assertSubagentMaxDepth(request.maxDepth)
  if (request.signal.aborted) throw prePublicationAbort()
  const parent = request.parent
  const childDepth = resolveChildDepth(parent, request.maxDepth)

  const childId = brandString<SessionId>(randomUUID())
  const seed = options.seed
  const activationBoundary = SessionLogOffset(seed?.length ?? 0)

  // Capture before the first await: a later parent switch belongs to the
  // parent's future.
  const inherited = captureDelegatedPolicyOverrides(parent)

  let structured: StructuredAttachment | undefined
  const setup = (childCtx: Context, child: Agent): void => {
    appendDelegatedPolicyOverrides(child.session, inherited)
    applyChildComposition(childCtx, parent, {
      persona: request.persona,
      toolFilter: request.toolFilter,
    })
    if (request.outputSchema !== undefined) {
      structured = attachStructuredRuntime(childCtx, request.outputSchema)
    }
    attachDescriptorAppend(childCtx, request.descriptor)
  }

  const handle = await parent.ctx.agents.create({
    sessionId: childId,
    parentAgent: parent,
    meta: childSessionMeta(parent, childDepth, seed !== undefined),
    ...seed !== undefined ? { seed } : {},
    ...seed === undefined ? {} : { inheritedEventCount: activationBoundary },
    agentOptions: resolveChildAgentOptions(parent, request.agentOptions, childDepth),
    signal: request.signal,
    setup,
  })
  return drivePublishedRun(
    handle,
    request.signal,
    request.prompt,
    childId,
    activationBoundary,
    structured,
  )
}

/**
 * Wrap a published child in the single run lifecycle that owns signal handoff,
 * one turn, result settlement, and quiescent disposal.
 */
function drivePublishedRun(
  handle: AgentHandle,
  signal: AbortSignal,
  prompt: ContentBlock[],
  childId: SessionId,
  boundary: SessionLogOffsetType,
  structured: StructuredAttachment | undefined,
): SubagentRun {
  const child = handle.agent
  const flags = { cancelled: false }
  const onAbort = (): void => {
    flags.cancelled = true
    child.cancel({ kind: 'parent' })
  }
  signal.addEventListener('abort', onAbort, { once: true })
  // Agent creation detaches its creation-only listener before returning. The
  // post-registration check closes that handoff without treating an already
  // published child as a failed start.
  if (signal.aborted) onAbort()

  const result: Promise<SubagentResult> = (async () => {
    try {
      let continuations = 0
      if (!flags.cancelled) {
        child.followup(createUserMessage({ content: prompt, source: { kind: 'user' } }))
        await child.whenIdle()
        // A truncated response is one cut-off message, not a finished task: the
        // child keeps its own log, so bounded continuation turns let it finish
        // instead of handing the parent half an answer.
        while (continuations < TRUNCATION_CONTINUATIONS && !flags.cancelled
          && lastTurnReason(child, boundary)?.kind === 'max-tokens') {
          continuations += 1
          child.followup(createUserMessage({
            content: [{ type: 'text', text: TRUNCATION_CONTINUATION }],
            source: { kind: 'user' },
          }))
          await child.whenIdle()
        }
      }
      return readResult(
        child,
        boundary,
        flags.cancelled,
        structured ? { captured: structured.captured() } : undefined,
        continuations,
      )
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  })()

  return {
    id: childId,
    localAgent: child,
    result,
    async dispose(): Promise<void> {
      signal.removeEventListener('abort', onAbort)
      flags.cancelled = true
      const settlements = await Promise.allSettled([handle.dispose(), result])
      const disposal = settlements[0]
      // The result channel owns run faults; disposal reports only failure to
      // release the published handle after both operations settle.
      if (disposal.status === 'rejected') throw disposal.reason
    },
  }
}

/** The recorded end reason of the child's latest settled turn, when it has one. */
function lastTurnReason(child: Agent, boundary: SessionLogOffsetType): TurnEndReason | undefined {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  return foldConsumedWork(child.session.snapshotEvents(boundary)).end?.data.reason
}

/**
 * Join every non-empty assistant message text of the child-owned suffix.
 *
 * The canonical selection rule picks the LAST message, which is the whole
 * answer for a one-turn run. A run this driver continued after truncation has
 * two halves of one answer, so the parent must receive both.
 * @param events - the child-owned events.
 * @returns the assistant text in log order, separated by a blank line.
 */
function joinedAssistantText(events: readonly SessionEvent[]): ContentBlock[] {
  const parts: string[] = []
  const others: ContentBlock[] = []
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    for (const block of event.data.message.content) {
      if (block.type !== 'text') {
        others.push(block)
        continue
      }
      const text = block.text.trim()
      if (text.length > 0) parts.push(text)
    }
  }
  return parts.length === 0 ? others : [...others, { type: 'text', text: parts.join('\n\n') }]
}

/** Read one settled child's result from events after its activation boundary. */
function readResult(
  child: Agent,
  boundary: SessionLogOffsetType,
  cancelled: boolean,
  structured?: { captured?: { value: unknown } | undefined },
  continuations = 0,
): SubagentResult {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  const own = child.session.snapshotEvents(boundary)
  // `droppedUnrun` is deliberately unread: a one-shot prompt is claimed by its
  // awaited first turn almost immediately, and the owner's own teardown is the
  // `cancelled` flag below. A cancellation with no accounting turn resolves
  // `error` through `toStopReason(undefined)`, which never overstates success.
  const lastEnd = foldConsumedWork(own).end
  // The seam's canonical selection rule; a partial answer survives cancel and truncation.
  // A continued run's answer is split across turns, so it reports the joined
  // text instead of only the post-truncation tail.
  const output: readonly ContentBlock[] = continuations === 0
    ? finalAssistantOutput(own) ?? []
    : joinedAssistantText(own)
  const recorded = toStopReason(lastEnd?.data.reason)
  // Disposal can tear the owner down before the loop records its ordinary
  // `aborted` end, yielding `disposed` instead.
  const stopReason: SubagentStopReason = cancelled && recorded !== 'completed' ? 'aborted' : recorded
  if (structured !== undefined) {
    if (structured.captured !== undefined) {
      return { output, structured: structured.captured.value, stopReason }
    }
    if (stopReason === 'completed') return { output, stopReason: cancelled ? 'aborted' : 'error' }
  }
  return { output, stopReason }
}
