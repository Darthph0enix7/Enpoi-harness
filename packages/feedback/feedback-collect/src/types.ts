/**
 * Feedback payload vocabulary: the share flags, the endpoint payload shape,
 * the triage JSON contract, and the structural service seams the
 * `sessionFeedback.record` pipeline consumes. Types only, so a Host or
 * browser bundle can import the contract without pulling runtime values.
 * @module @deepseek-ai/dsh-feedback-collect/types
 */

/** Which optional payload sections the human shared. Absent request fields default to true. */
export interface FeedbackShareFlags {
  /** Anonymous system facts: versions, platform, provider ids, default model. */
  readonly systemInfo: boolean
  /** Recent conversation context: messages, tool calls, errors. */
  readonly context: boolean
  /** Session facts: hashed id, counts, preset/model, recent errors. */
  readonly session: boolean
  /**
   * The human's own typed message. False omits the message text from the
   * ENDPOINT payload (the local `feedback/record` event always keeps it — the
   * record is the user's own log); the endpoint accepts telemetry-only
   * payloads.
   */
  readonly message: boolean
}

/** Anonymous system section of the payload. */
export interface FeedbackSystemSection {
  readonly app: { readonly name: string; readonly version: string; readonly commit: string }
  readonly platform: string
  readonly arch: string
  readonly node: string
  /** Provider route ids only; never credentials. */
  readonly providers: readonly string[]
  /** The session's default `provider/model` selection, or null when unresolved. */
  readonly defaultModel: string | null
}

/** One bounded conversation excerpt. */
export interface FeedbackContextMessage {
  readonly role: 'user' | 'assistant' | 'system'
  /** Redacted, truncated text. */
  readonly text: string
}

/** One bounded tool-call excerpt. */
export interface FeedbackContextToolCall {
  readonly name: string
  /** Redacted, truncated argument text. */
  readonly arguments: string
}

/** Recent-conversation section of the payload. */
export interface FeedbackContextSection {
  readonly messages: readonly FeedbackContextMessage[]
  readonly toolCalls: readonly FeedbackContextToolCall[]
  readonly errors: readonly string[]
}

/** Session facts section of the payload. */
export interface FeedbackSessionSection {
  /** Salted hash of the session id; the raw id never leaves the device. */
  readonly sessionIdHash: string
  readonly eventCount: number
  readonly turnCount: number
  readonly preset: string | null
  readonly model: string | null
  readonly recentErrors: readonly string[]
}

/** The three optional sections one collection produced. */
export interface FeedbackPayloadSections {
  readonly system?: FeedbackSystemSection
  readonly context?: FeedbackContextSection
  readonly session?: FeedbackSessionSection
}

/** Severity the triage model may report. */
export type FeedbackSeverity = 'low' | 'medium' | 'high'

/** Strict triage answer the triage session must produce. */
export interface FeedbackTriage {
  readonly category: string
  readonly severity: FeedbackSeverity
  readonly summary: string
  readonly details?: string
}

/** The endpoint payload the submit client posts. */
export interface FeedbackEndpointPayload {
  readonly app: { readonly name: string; readonly version: string; readonly commit: string }
  /** The human's remark; absent when the message flag was off (telemetry-only payload). */
  readonly message?: string
  readonly category?: string
  readonly flags: FeedbackShareFlags
  readonly system?: FeedbackSystemSection
  readonly context?: FeedbackContextSection
  readonly session?: FeedbackSessionSection
  readonly analysis?: FeedbackTriage
  readonly meta: { readonly submittedAt: string; readonly installIdHash: string }
}

/** Structural seam the collector implements; consumed by the record pipeline. */
export interface FeedbackCollectService {
  /**
   * Build the shared sections for one session.
   * @param input - live session plus the resolved share flags.
   * @returns the sections, or null when collection itself failed (fail-soft).
   */
  collect(input: { session: unknown; share: FeedbackShareFlags }): Promise<FeedbackPayloadSections | null>
}

/** Structural seam the triage session implements. */
export interface FeedbackTriageService {
  /**
   * Triage one payload in an isolated session.
   * @param input - the message plus the shared sections.
   * @returns the parsed triage, or null on any miss (fail-soft).
   */
  triage(input: {
    message: string
    category?: string
    sections: FeedbackPayloadSections
  }): Promise<FeedbackTriage | null>
}

/** Structural seam the submit client implements. */
export interface FeedbackSubmitService {
  /** Whether submission is enabled by configuration. */
  enabled(): boolean
  /**
   * POST one payload to the configured endpoint.
   * @param payload - the endpoint payload.
   * @returns the server id, or null on any failure (fail-soft).
   */
  submit(payload: FeedbackEndpointPayload): Promise<{ id: string } | null>
}
