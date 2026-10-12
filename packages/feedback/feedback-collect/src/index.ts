/**
 * Feedback payload builder and anonymizer: turns one live Session plus the
 * deployment's system facts into the bounded, redacted sections the endpoint
 * receives. Every builder is a pure function over plain inputs; the service is
 * a thin collector that reads the live session, the mounted `llm` and
 * `agentDefaultModel` services, and the anonymous install id. The redactor is
 * focused (secret-looking tokens, home paths, emails) because the telemetry
 * waterfall is export-scoped and not reachable as a function.
 * @module @deepseek-ai/dsh-feedback-collect
 */

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { APP_IDENTITY } from '@deepseek-ai/dsh-llm'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import type {
  FeedbackCollectService,
  FeedbackContextMessage,
  FeedbackContextSection,
  FeedbackContextToolCall,
  FeedbackPayloadSections,
  FeedbackSessionSection,
  FeedbackShareFlags,
  FeedbackSystemSection,
} from './types.ts'

export type * from './types.ts'

export const name = 'feedback-collect'

/** Default per-section bounds; the endpoint cap is 2 MiB and these stay far below it. */
export const COLLECT_LIMITS = {
  /** Messages retained from the end of the conversation. */
  maxMessages: 40,
  /** Tool calls retained from the end of the conversation. */
  maxToolCalls: 40,
  /** Errors retained from the end of the conversation. */
  maxErrors: 10,
  /** Characters retained per message. */
  maxMessageChars: 2_000,
  /** Characters retained per tool-call argument string. */
  maxArgumentChars: 1_000,
  /** Characters retained per error line. */
  maxErrorChars: 500,
} as const

/** Key-like token shapes redacted wherever free text is collected. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}/gu,
  /\bghp_[A-Za-z0-9]{16,}/gu,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/gu,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/gu,
  /\bBearer\s+\S{12,}/giu,
  /(?<=(?:api(?:_|-)?key|token|secret|password|passwd|authorization)"?\s*[=:]\s*"?)[^\s,;'"]{6,}/giu,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/gu,
]

/** One email address. */
const EMAIL_PATTERN = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/gu

/**
 * Redact free text: secret-looking tokens, emails, and home-directory paths.
 * Pure and deterministic; the caller passes the home directory so tests never
 * depend on the process environment.
 * @param text - raw text.
 * @param home - the home directory to anonymize to `~`; empty disables the path rule.
 * @returns the redacted text.
 */
export function redactText(text: string, home: string): string {
  let output = text
  if (home !== '') {
    // Only a whole path segment is replaced, so a home directory that is a
    // prefix of a sibling path never mangles it.
    const escaped = home.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')
    output = output.replace(new RegExp(`${escaped}(?=$|[/\\s'"])`, 'gu'), '~')
  }
  output = output.replace(EMAIL_PATTERN, '<email>')
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match) => {
      // Keep an assignment's key readable; replace only the value.
      const separator = /[=:]\s*$/u.exec(match)
      return separator === null ? '<redacted>' : `${separator[0]}<redacted>`
    })
  }
  return output
}

/** Truncate to a character bound with an explicit marker. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** One structural session event as the collector reads it. */
export interface CollectedEvent {
  readonly type: string
  readonly data?: Record<string, unknown>
}

/** Structural view of the live session the collector reads. */
export interface CollectableSession {
  readonly id: string
  readonly events?: readonly CollectedEvent[]
  /** Live sessions expose `snapshotEvents()`; kept optional for tests. */
  snapshotEvents?: () => readonly CollectedEvent[]
  readonly header?: { readonly agentPreset?: unknown }
}

function eventsOf(session: CollectableSession): readonly CollectedEvent[] {
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  return session.events ?? []
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map(block => (typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : ''))
      .join(' ')
      .trim()
  }
  return ''
}

/**
 * Build the bounded context section from one session's event stream. Reads the
 * tail of the conversation; every text passes through {@link redactText}.
 * @param events - session events in log order.
 * @param home - home directory for path anonymization.
 * @param limits - per-field bounds; defaults to {@link COLLECT_LIMITS}.
 * @returns the context section.
 */
export function buildContextSection(
  events: readonly CollectedEvent[],
  home: string,
  limits: typeof COLLECT_LIMITS = COLLECT_LIMITS,
): FeedbackContextSection {
  const messages: FeedbackContextMessage[] = []
  const toolCalls: FeedbackContextToolCall[] = []
  const errors: string[] = []
  for (const event of events) {
    const data = event.data ?? {}
    if (event.type === 'user/message') {
      messages.push({ role: 'user', text: clip(redactText(textOf(data['content']), home), limits.maxMessageChars) })
    } else if (event.type === 'assistant/message') {
      messages.push({ role: 'assistant', text: clip(redactText(textOf(data['content']), home), limits.maxMessageChars) })
    } else if (event.type === 'tool/call') {
      const name = typeof data['name'] === 'string' ? data['name'] : 'unknown'
      toolCalls.push({
        name,
        arguments: clip(redactText(typeof data['arguments'] === 'string' ? data['arguments'] : '', home), limits.maxArgumentChars),
      })
    } else if (event.type === 'turn/end') {
      const end = data['end'] as { kind?: unknown; error?: { message?: unknown } } | undefined
      if (end?.kind === 'error' && typeof end.error?.message === 'string') {
        errors.push(clip(redactText(end.error.message, home), limits.maxErrorChars))
      }
    }
  }
  return {
    messages: messages.slice(-limits.maxMessages),
    toolCalls: toolCalls.slice(-limits.maxToolCalls),
    errors: errors.slice(-limits.maxErrors),
  }
}

/**
 * Build the session facts section: a salted hash instead of the id, counts,
 * preset/model, and the recent errors already redacted by the context builder.
 * @param input - session identity, events, preset/model, and salt.
 * @returns the session section.
 */
export function buildSessionSection(input: {
  sessionId: string
  events: readonly CollectedEvent[]
  preset?: string | null
  model?: string | null
  salt: string
  home?: string
}): FeedbackSessionSection {
  const events = input.events
  const turns = events.filter(event => event.type === 'turn/start').length
  const errors = events
    .filter(event => event.type === 'turn/end')
    .map((event) => {
      const end = event.data?.['end'] as { kind?: unknown; error?: { message?: unknown } } | undefined
      return end?.kind === 'error' && typeof end.error?.message === 'string' ? end.error.message : undefined
    })
    .filter((message): message is string => message !== undefined)
    .slice(-COLLECT_LIMITS.maxErrors)
    .map(message => clip(redactText(message, input.home ?? ''), COLLECT_LIMITS.maxErrorChars))
  return {
    sessionIdHash: createHash('sha256').update(`${input.salt}:${input.sessionId}`).digest('hex'),
    eventCount: events.length,
    turnCount: turns,
    preset: input.preset ?? null,
    model: input.model ?? null,
    recentErrors: errors,
  }
}

/**
 * Build the anonymous system section. Provider ids and the default model are
 * the only deployment facts collected; credentials never enter this shape.
 * @param input - identity, platform facts, provider ids, default model.
 * @returns the system section.
 */
export function buildSystemSection(input: {
  app?: { name: string; version: string; commit: string }
  platform: string
  arch: string
  node: string
  providers: readonly string[]
  defaultModel: string | null
}): FeedbackSystemSection {
  return {
    app: input.app ?? {
      name: APP_IDENTITY.product,
      version: APP_IDENTITY.version,
      // The release build stamps this into the environment; a source checkout
      // reports an empty commit rather than guessing.
      commit: process.env['DSH_CLIENT_COMMIT_HASH'] ?? '',
    },
    platform: input.platform,
    arch: input.arch,
    node: input.node,
    providers: [...input.providers],
    defaultModel: input.defaultModel,
  }
}

/** The deployment's default model selection, or undefined when unresolved. */
function defaultModelSelection(ctx: Context): { provider?: unknown; model?: unknown } | undefined {
  const service = ctx.get('agentDefaultModel') as unknown as {
    currentSelection: () => { provider?: unknown; model?: unknown }
  } | undefined
  return service === undefined ? undefined : service.currentSelection()
}

/** Resolve share flags with the contract defaults (absent = true). */
export function resolveShareFlags(share?: Partial<FeedbackShareFlags>): FeedbackShareFlags {
  return {
    systemInfo: share?.systemInfo ?? true,
    context: share?.context ?? true,
    session: share?.session ?? true,
    message: share?.message ?? true,
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    feedbackCollect: FeedbackCollector
  }
}

/** Collect one payload's sections from a live session and the host context. */
export class FeedbackCollector extends Service implements FeedbackCollectService {
  /**
   * @param ctx - host context; `llm` and `agentDefaultModel` are optional.
   */
  constructor(ctx: Context) {
    super(ctx, 'feedbackCollect')
  }

  /**
   * Build the shared sections for one session, honoring the share flags.
   * @param input - live session plus resolved share flags.
   * @returns the sections, or null when even the session could not be read.
   */
  collect(input: { session: unknown; share: FeedbackShareFlags }): Promise<FeedbackPayloadSections | null> {
    try {
      const session = input.session as CollectableSession
      const events = eventsOf(session)
      const home = homedir()
      const sections: {
        system?: FeedbackSystemSection
        context?: FeedbackContextSection
        session?: FeedbackSessionSection
      } = {}
      if (input.share.systemInfo) {
        const llm = this.ctx.get('llm') as { listProviders?: () => { id?: unknown }[] } | undefined
        const providers = (llm?.listProviders?.() ?? [])
          .map(provider => (typeof provider.id === 'string' ? provider.id : ''))
          .filter(id => id !== '')
        const selection = defaultModelSelection(this.ctx)
        const defaultModel = typeof selection?.provider === 'string' && typeof selection.model === 'string'
          ? `${selection.provider}/${selection.model}`
          : null
        sections.system = buildSystemSection({
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          providers,
          defaultModel,
        })
      }
      if (input.share.context) sections.context = buildContextSection(events, home)
      if (input.share.session) {
        const header = session.header ?? {}
        const preset = typeof header.agentPreset === 'string' ? header.agentPreset : null
        // The session header records the preset but not the route; the
        // deployment default is the model the session ran on unless the agent
        // overrode it, so it is the honest value to report.
        const selection = defaultModelSelection(this.ctx)
        const model = typeof selection?.provider === 'string' && typeof selection.model === 'string'
          ? `${selection.provider}/${selection.model}`
          : null
        sections.session = buildSessionSection({
          sessionId: session.id,
          events,
          preset,
          model,
          salt: getOrCreateAnonymousUserId(),
          home,
        })
      }
      return Promise.resolve(sections)
    } catch (error: unknown) {
      this.ctx.logger.warn('feedback-collect: could not collect the payload sections:', error)
      return Promise.resolve(null)
    }
  }
}

/**
 * Mount the collector as an optional service other packages read through
 * `ctx.get('feedbackCollect')`.
 * @param ctx - host context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(FeedbackCollector)
}
