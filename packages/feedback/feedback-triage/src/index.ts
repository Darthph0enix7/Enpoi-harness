/**
 * Feedback triage: one ephemeral, isolated agent session that classifies a
 * recorded remark plus its shared payload into the strict triage JSON
 * `{category, severity, summary, details?}`. The session mirrors the first-run
 * system-analysis pattern — branded id, the `system-analysis` permission
 * preset, the keyless Kilo free route, a hard time bound — and is disposed
 * after idle WITHOUT archiving; its durable session artifacts are deleted, so
 * it never pollutes the session rail. Every
 * failure returns null: triage is advisory and must never fail the record
 * path.
 * @module @deepseek-ai/dsh-feedback-triage
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { brandString } from '@deepseek-ai/dsh-brand'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  FeedbackPayloadSections,
  FeedbackSeverity,
  FeedbackTriage,
  FeedbackTriageService,
} from '@deepseek-ai/dsh-feedback-collect/types'

export type * from '@deepseek-ai/dsh-feedback-collect/types'

export const name = 'feedback-triage'

/** The seven durable feedback category ids the triage answer must use. */
export const TRIAGE_CATEGORIES = [
  'task-result',
  'instruction-following',
  'product-interaction',
  'service-stability',
  'resource-cost',
  'security-privacy-permission',
  'other',
] as const

/** Severities the triage answer may carry. */
export const TRIAGE_SEVERITIES = ['low', 'medium', 'high'] as const

/** Scratch workspace one triage run owns, under the harness home. */
export function triageWorkspacePath(): string {
  return dshHomePath('feedback-triage-work')
}

/**
 * The one message that opens a triage run. Kept verbatim and pinned by tests.
 * @param input - the recorded message plus the shared sections.
 * @returns the prompt text.
 */
export function buildTriagePrompt(input: {
  message: string
  category?: string
  sections: FeedbackPayloadSections
}): string {
  const payload = {
    message: input.message,
    ...(input.category === undefined ? {} : { category: input.category }),
    ...input.sections,
  }
  return [
    'You triage one piece of user feedback about the DeepSeek Harness. Read the JSON payload below and answer with ONE JSON object, nothing else.',
    '',
    'The answer must be exactly:',
    `{"category": "<one of: ${TRIAGE_CATEGORIES.join(', ')}>", "severity": "low" | "medium" | "high", "summary": "<one sentence>", "details": "<optional short paragraph>"}`,
    '',
    'Rules:',
    '- Pick the single best category; use "other" only when none fits.',
    '- Severity reflects user impact: "high" for data loss, crashes, security, or a blocked workflow; "medium" for a degraded but usable workflow; "low" for cosmetic or minor friction.',
    '- The summary is one factual sentence in English, no markdown, no quotes around it.',
    '- Never include credentials, paths, or anything not present in the payload.',
    '',
    'Payload:',
    JSON.stringify(payload, null, 2),
  ].join('\n')
}

/**
 * Extract the triage object from a model reply: tolerates fenced or
 * prose-wrapped JSON, and rejects anything that is not the strict contract.
 * @param text - raw model reply.
 * @returns the parsed triage, or null when no strict object is present.
 */
export function parseTriage(text: string): FeedbackTriage | null {
  const candidates: string[] = []
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/gu
  for (const match of text.matchAll(fenced)) {
    if (typeof match[1] === 'string') candidates.push(match[1])
  }
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
      const record = parsed as Record<string, unknown>
      const category = record['category']
      const severity = record['severity']
      const summary = record['summary']
      const details = record['details']
      if (typeof category !== 'string' || !(TRIAGE_CATEGORIES as readonly string[]).includes(category)) continue
      if (typeof severity !== 'string' || !(TRIAGE_SEVERITIES as readonly string[]).includes(severity)) continue
      if (typeof summary !== 'string' || summary.trim() === '') continue
      if (details !== undefined && typeof details !== 'string') continue
      return {
        category,
        severity: severity as FeedbackSeverity,
        summary: summary.trim(),
        ...(details === undefined ? {} : { details }),
      }
    } catch (_invalidCandidate) {
      continue
    }
  }
  return null
}

/**
 * Watch one session's live events and keep the latest assistant text. The
 * synchronous session snapshot is deprecated, so the reply is captured from
 * the event stream while the run is alive.
 * @param ctx - host context.
 * @param sessionId - the triage session to watch.
 * @returns the latest text accessor plus its unsubscribe.
 */
function watchAssistantText(ctx: Context, sessionId: SessionId): { text: () => string | undefined; stop: () => void } {
  let latest: string | undefined
  const stop = ctx.on('session/event', (session, event) => {
    if (session.id !== sessionId || event.type !== 'assistant/message') return
    const content = (event.data as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) return
    const text = content
      .filter(block => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
      .map(block => (typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : ''))
      .join('')
      .trim()
    if (text !== '') latest = text
  }) as unknown as () => void
  return { text: () => latest, stop }
}

/** What one triage run needs from the deployment. */
export interface TriageOptions {
  /** Host context carrying the agent runtime and the optional preset/permission/title services. */
  readonly ctx: Context
  /** Scratch workspace the triage session owns. */
  readonly workspace: string
  /** Provider route the triage agent runs on (the keyless Kilo free route). */
  readonly provider: string
  /** Model id on that route. */
  readonly model: string
  /** Agent preset mounted for the triage session. */
  readonly preset: string
  /** Permission preset enforced for the triage session. */
  readonly permissionPreset: string
  /** Hard bound on one triage run, in minutes. */
  readonly timeoutMinutes: number
}

/** Injectable runner seam: the service delegates to this function. */
export type FeedbackTriageRunner = (
  input: { message: string; category?: string; sections: FeedbackPayloadSections },
  signal: AbortSignal,
) => Promise<FeedbackTriage | null>

/**
 * Run one bounded triage in an isolated session and return the parsed answer.
 * The session is disposed (never archived), its durable session artifacts
 * deleted, and its scratch workspace removed before this resolves; every
 * failure returns null.
 * @param options - deployment services, route, preset, bound, and workspace.
 * @param input - the recorded message plus the shared sections.
 * @param signal - caller cancellation; a hard timeout is added inside.
 * @returns the parsed triage, or null.
 */
export async function runFeedbackTriage(
  options: TriageOptions,
  input: { message: string; category?: string; sections: FeedbackPayloadSections },
  signal?: AbortSignal,
): Promise<FeedbackTriage | null> {
  const ctx = options.ctx
  const agents = ctx.get('agents')
  if (agents === undefined) {
    ctx.logger.warn('feedback-triage: no agent runtime is mounted; triage skipped')
    return null
  }
  const presets = ctx.get('agentPresets')
  if (presets === undefined) {
    ctx.logger.warn('feedback-triage: no agent preset registry is mounted; triage skipped')
    return null
  }
  rmSync(options.workspace, { recursive: true, force: true })
  mkdirSync(options.workspace, { recursive: true })
  const timeout = new AbortController()
  const timer = setTimeout(() => {
    timeout.abort(new Error(`feedback triage did not finish within ${options.timeoutMinutes} minute(s)`))
  }, options.timeoutMinutes * 60_000)
  const bound = signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal])
  const sessionId = brandString<SessionId>(`feedback-triage-${randomUUID()}`)
  let handle: AgentHandle | undefined
  let assistant: { text: () => string | undefined; stop: () => void } | undefined
  try {
    const preset = await presets.resolve(options.preset)
    await using presetScope = await presets.acquireScope(preset.id)
    void presetScope
    handle = await agents.create({
      sessionId,
      signal: bound,
      meta: { cwd: options.workspace, agentPreset: preset.id },
      agentOptions: { provider: options.provider, model: options.model },
      setup: async (agentCtx) => {
        await presets.mount(agentCtx, preset.id)
      },
    })
    const permissions = ctx.get('permissionPresets') as unknown as { set(session: unknown, preset: string): void } | undefined
    if (permissions !== undefined) {
      try {
        permissions.set(handle.agent.session, options.permissionPreset)
      } catch (error: unknown) {
        ctx.logger.warn('feedback-triage: permission preset "%s" is unavailable: %s', options.permissionPreset, error)
      }
    }
    const title = ctx.get('sessionTitle') as unknown as { rename(session: unknown, title: string): void } | undefined
    if (title !== undefined) title.rename(handle.agent.session, 'Feedback triage')
    assistant = watchAssistantText(ctx, sessionId)
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: buildTriagePrompt(input) }],
      source: { kind: 'user' },
    }))
    await Promise.race([
      handle.agent.whenIdle(),
      new Promise<never>((_resolve, reject) => {
        const fail = (): void => {
          reject(bound.reason instanceof Error ? bound.reason : new Error(String(bound.reason)))
        }
        if (bound.aborted) {
          fail()
          return
        }
        bound.addEventListener('abort', fail, { once: true })
      }),
    ])
    const reply = assistant.text()
    if (reply === undefined) {
      // ctx.logger output is not wired to the service journal; this line keeps
      // the miss visible where operators look.
      console.error('[feedback-triage] no assistant reply captured; analysis skipped')
    }
    return reply === undefined ? null : parseTriage(reply)
  } catch (error: unknown) {
    ctx.logger.warn('feedback-triage: triage failed:', error)
    return null
  } finally {
    clearTimeout(timer)
    if (assistant !== undefined) assistant.stop()
    try {
      await handle?.dispose()
    } catch (error: unknown) {
      ctx.logger.warn('feedback-triage: the triage session did not dispose cleanly:', error)
    }
    // Dispose detaches the live entry; the durable log is what the session
    // list reads, so remove it or the rail lists one session per triage.
    const persistence = ctx.get('sessionPersistence') as { delete?: (id: SessionId) => Promise<void> } | undefined
    try {
      await persistence?.delete?.(sessionId)
    } catch (error: unknown) {
      ctx.logger.warn('feedback-triage: the triage session artifacts were not deleted:', error)
    }
    rmSync(options.workspace, { recursive: true, force: true })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    feedbackTriage: FeedbackTriageSession
  }
}

/** Validated deployment choices for the triage session. */
export interface Config {
  /** Provider route the triage agent runs on. */
  provider?: string
  /** Model id on that route. */
  model?: string
  /** Agent preset mounted for the triage session. */
  preset?: string
  /** Permission preset enforced for the triage session. */
  permissionPreset?: string
  /** Hard bound on one triage run, in minutes. */
  timeoutMinutes?: number
}

/**
 * Route the triage session runs on when nothing overrides it. Measured against
 * the live Kilo gateway on 2026-10-25: `poolside/laguna-s-2.1:free` answered
 * with real content, while the retired `kilo-auto/free` answered 200 with
 * EMPTY content. The first-run seed and the system analysis write the same
 * pair.
 */
export const DEFAULT_TRIAGE_ROUTE = { provider: 'kilo', model: 'poolside/laguna-s-2.1:free' } as const

/** Config schema with the first-run system-analysis defaults. */
export const Config = Schema.object({
  provider: Schema.string().default(DEFAULT_TRIAGE_ROUTE.provider),
  model: Schema.string().default(DEFAULT_TRIAGE_ROUTE.model),
  preset: Schema.string().default('sysadmin'),
  permissionPreset: Schema.string().default('system-analysis'),
  timeoutMinutes: Schema.number().min(1).max(60).default(5),
})

/** Service wrapper: routes `triage()` through the injectable runner. */
export class FeedbackTriageSession extends Service implements FeedbackTriageService {
  static Config = Config

  /**
   * @param ctx - host context.
   * @param config - validated deployment choices.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'feedbackTriage')
    this.runner = (input, signal) => runFeedbackTriage({
      ctx: this.ctx,
      workspace: triageWorkspacePath(),
      provider: config.provider ?? DEFAULT_TRIAGE_ROUTE.provider,
      model: config.model ?? DEFAULT_TRIAGE_ROUTE.model,
      preset: config.preset ?? 'sysadmin',
      permissionPreset: config.permissionPreset ?? 'system-analysis',
      timeoutMinutes: config.timeoutMinutes ?? 5,
    }, input, signal)
  }

  /** The runner seam; tests replace it with a fake. */
  runner: FeedbackTriageRunner

  /**
   * Triage one payload in an isolated session.
   * @param input - the message plus the shared sections.
   * @returns the parsed triage, or null on any miss.
   */
  async triage(input: { message: string; category?: string; sections: FeedbackPayloadSections }): Promise<FeedbackTriage | null> {
    try {
      return await this.runner(input, new AbortController().signal)
    } catch (error: unknown) {
      this.ctx.logger.warn('feedback-triage: triage failed:', error)
      return null
    }
  }
}

/**
 * Mount the triage service as `ctx.feedbackTriage`.
 * @param ctx - host context.
 * @param config - validated deployment choices.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.plugin(FeedbackTriageSession, config)
}
