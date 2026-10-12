/**
 * Session feedback: the `feedback/record` event, its command-independent
 * producer, the `sessionFeedback` Host Remote a product surface records
 * through, and the human-facing `/feedback` command. Recording appends one
 * authoritative log-only event and does not start model work. The append is
 * eager but unflushed, so acknowledgement reports that the entry is logged,
 * not that it reached disk.
 * @module @deepseek-ai/dsh-command-feedback
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Session } from '@deepseek-ai/dsh-session'
import { APP_IDENTITY } from '@deepseek-ai/dsh-llm'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { resolveShareFlags } from '@deepseek-ai/dsh-feedback-collect'
import type {
  FeedbackCollectService,
  FeedbackEndpointPayload,
  FeedbackSubmitService,
  FeedbackTriageService,
} from '@deepseek-ai/dsh-feedback-collect/types'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type {
  FeedbackCategory,
  FeedbackRecord,
  SessionFeedbackRecordRequest,
  SessionFeedbackRecordResult,
} from './types.ts'

export type * from './types.ts'

/**
 * Every feedback category in the order product surfaces present them; each
 * surface owns its localized labels.
 */
export const FEEDBACK_CATEGORIES = [
  'task-result',
  'instruction-following',
  'product-interaction',
  'service-stability',
  'resource-cost',
  'security-privacy-permission',
  'other',
] as const satisfies readonly FeedbackCategory[]

export const name = 'command-feedback'
export const inject = ['commands']

const USAGE = 'Usage: /feedback <text>'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionFeedback: SessionFeedbackService
  }
}

/**
 * Record feedback independently of any UI trigger. Surrounding whitespace is
 * discarded and a blank text is recorded as absent; an entry with neither
 * text nor category is still recorded.
 * @param session - session the feedback describes.
 * @param entry - human-authored remark and its category.
 */
export function recordFeedback(session: Session, entry: FeedbackRecord): void {
  const text = entry.text?.trim() ?? ''
  session.append('feedback/record', {
    ...(text.length === 0 ? {} : { text }),
    ...(entry.category === undefined ? {} : { category: entry.category }),
  })
}

/**
 * Validate, record, and acknowledge one feedback entry. Returning an error
 * leaves no `feedback/record` event.
 * @param invocation - receiving agent, raw command input, and UI cancellation.
 * @returns an acknowledgement containing the receiving session and anonymous
 * user ids, or a usage error when no feedback text was supplied.
 */
function executeFeedbackCommand(invocation: CommandInvocation, ctx: Context): CommandResult {
  if (invocation.rawInput.trim().length === 0) {
    return { kind: 'error', text: `Feedback text is required. ${USAGE}` }
  }
  recordFeedback(invocation.agent.session, { text: invocation.rawInput })
  // The command result is synchronous, so the collect/triage/submit pipeline
  // continues in the background; every step is fail-soft and the record above
  // is the only step the human waits for.
  void runFeedbackPipeline(ctx, {
    session: invocation.agent.session,
    text: invocation.rawInput,
    share: { systemInfo: true, context: true, session: true, message: true },
    submit: true,
  })
  return {
    kind: 'success',
    text: `Feedback recorded for session ${invocation.agent.session.id}\nAnonymous user: ${getOrCreateAnonymousUserId()}.`,
  }
}

/** One pipeline input: the recorded remark plus its share/submit choices. */
interface PipelineInput {
  readonly session: Session
  readonly text?: string
  readonly category?: FeedbackCategory
  readonly share: { readonly systemInfo: boolean; readonly context: boolean; readonly session: boolean; readonly message: boolean }
  readonly submit: boolean
}

/** Build the endpoint payload from the collected sections and the triage answer. */
function endpointPayload(
  input: PipelineInput,
  sections: Awaited<ReturnType<FeedbackCollectService['collect']>>,
  analysis: Awaited<ReturnType<FeedbackTriageService['triage']>>,
): FeedbackEndpointPayload {
  return {
    app: { name: APP_IDENTITY.product, version: APP_IDENTITY.version, commit: process.env['DSH_CLIENT_COMMIT_HASH'] ?? '' },
    // The message flag governs the endpoint payload only; the local record
    // keeps the text regardless, and the endpoint accepts telemetry-only
    // payloads.
    ...(input.share.message && input.text !== undefined ? { message: input.text } : {}),
    ...(input.category === undefined ? {} : { category: input.category }),
    flags: input.share,
    ...(sections?.system === undefined ? {} : { system: sections.system }),
    ...(sections?.context === undefined ? {} : { context: sections.context }),
    ...(sections?.session === undefined ? {} : { session: sections.session }),
    ...(analysis === null ? {} : { analysis }),
    meta: {
      submittedAt: new Date().toISOString(),
      installIdHash: createHash('sha256').update(getOrCreateAnonymousUserId()).digest('hex'),
    },
  }
}

/**
 * Collect, triage, and submit one recorded remark. Every step is optional and
 * fail-soft: a missing service, a collection failure, a triage miss, or a dead
 * endpoint each degrade to null without failing the record path.
 * @param ctx - host context the optional services are read from.
 * @param input - the recorded remark plus its share/submit choices.
 * @returns the triage answer and the submitted id, both possibly null.
 */
async function runFeedbackPipeline(
  ctx: Context,
  input: PipelineInput,
): Promise<{ analysis: Awaited<ReturnType<FeedbackTriageService['triage']>>; submitted: { id: string } | null }> {
  let sections: Awaited<ReturnType<FeedbackCollectService['collect']>> = null
  const collector = ctx.get('feedbackCollect') as unknown as FeedbackCollectService | undefined
  if (collector !== undefined) {
    try {
      sections = await collector.collect({ session: input.session, share: input.share })
    } catch (error: unknown) {
      ctx.logger.warn('command-feedback: payload collection failed:', error)
    }
  }
  let analysis: Awaited<ReturnType<FeedbackTriageService['triage']>> = null
  const triage = ctx.get('feedbackTriage') as unknown as FeedbackTriageService | undefined
  if (triage !== undefined && sections !== null) {
    try {
      analysis = await triage.triage({
        message: input.text ?? '',
        ...(input.category === undefined ? {} : { category: input.category }),
        sections,
      })
    } catch (error: unknown) {
      ctx.logger.warn('command-feedback: triage failed:', error)
    }
  }
  let submitted: { id: string } | null = null
  const submit = ctx.get('feedbackSubmit') as unknown as FeedbackSubmitService | undefined
  if (input.submit && submit !== undefined && submit.enabled()) {
    try {
      submitted = await submit.submit(endpointPayload(input, sections, analysis))
    } catch (error: unknown) {
      ctx.logger.warn('command-feedback: submission failed:', error)
    }
  }
  return { analysis, submitted }
}

/** Host Remote through which a product surface records a Session-level remark. */
export class SessionFeedbackService extends TypertRemoteService {
  static inject = ['sessions']

  /**
   * @param ctx - Host context carrying the live Session store.
   */
  constructor(ctx: Context) {
    super(ctx, 'sessionFeedback')
  }

  /**
   * Record one remark on a live Session.
   * @param request - target Session plus the optional text and category.
   * @returns the recorded postcondition, or `session-not-found` when no live
   * Session carries the id.
   */
  @Remote('record')
  async record(request: SessionFeedbackRecordRequest): Promise<SessionFeedbackRecordResult> {
    const session = this.ctx.sessions.get(request.sessionId)
    if (session === undefined) {
      return { ok: false, error: { code: 'session-not-found', sessionId: request.sessionId } }
    }
    recordFeedback(session, request)
    const { analysis, submitted } = await runFeedbackPipeline(this.ctx, {
      session,
      ...(request.text === undefined ? {} : { text: request.text }),
      ...(request.category === undefined ? {} : { category: request.category }),
      share: resolveShareFlags(request.share),
      submit: request.submit ?? true,
    })
    return { ok: true, value: { recorded: true, submitted, analysis } }
  }
}

/**
 * Register the global `/feedback` command for every composed command adapter
 * and mount the `sessionFeedback` Remote.
 * @param ctx - Host context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(SessionFeedbackService)
  ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-feedback'),
    name: 'feedback',
    description: 'Record feedback about this session',
    input: { hint: '<text>' },
    recordInput: false,
    handler: invocation => executeFeedbackCommand(invocation, ctx),
  })
}
