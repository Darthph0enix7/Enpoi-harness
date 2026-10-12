/**
 * Feedback submission client: one JSON POST to the deployment's feedback
 * endpoint, disabled or pointed elsewhere through the plugin's config row.
 * Submission is fail-soft by contract — the caller has already recorded the
 * remark locally, and a dead endpoint must never fail the record path — so
 * every failure (network, timeout, non-2xx, unparsable reply) returns null
 * after at most one retry.
 * @module @deepseek-ai/dsh-feedback-submit
 */

import { setTimeout as delay } from 'node:timers/promises'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { FeedbackEndpointPayload, FeedbackSubmitService } from '@deepseek-ai/dsh-feedback-collect/types'

export type * from '@deepseek-ai/dsh-feedback-collect/types'

export const name = 'feedback-submit'

/** Validated deployment choices for the submit client. */
export interface Config {
  /** Whether submission runs at all; the local record always happens. */
  enabled?: boolean
  /** Endpoint the payload is posted to. */
  endpoint?: string
  /** Deadline for one attempt, in milliseconds. */
  timeoutMs?: number
  /** Delay before the single retry, in milliseconds. */
  retryDelayMs?: number
}

/** Config schema with the contract defaults: submission on, our endpoint. */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  endpoint: Schema.string().default('https://enpoi.vip/feedback'),
  timeoutMs: Schema.number().min(100).max(120_000).default(15_000),
  retryDelayMs: Schema.number().min(0).max(10_000).default(500),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    feedbackSubmit: FeedbackSubmit
  }
}

/** POST client for the feedback endpoint. */
export class FeedbackSubmit extends Service implements FeedbackSubmitService {
  static Config = Config

  /**
   * @param ctx - host context.
   * @param config - validated deployment choices.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'feedbackSubmit')
    this._enabled = config.enabled ?? true
    this._endpoint = config.endpoint ?? 'https://enpoi.vip/feedback'
    this._timeoutMs = config.timeoutMs ?? 15_000
    this._retryDelayMs = config.retryDelayMs ?? 500
  }

  private readonly _enabled: boolean
  private readonly _endpoint: string
  private readonly _timeoutMs: number
  private readonly _retryDelayMs: number

  /** Whether submission is enabled by configuration. */
  enabled(): boolean {
    return this._enabled
  }

  /**
   * POST one payload to the configured endpoint with at most one retry.
   * @param payload - the endpoint payload.
   * @returns the server id, or null on any failure.
   */
  async submit(payload: FeedbackEndpointPayload): Promise<{ id: string } | null> {
    if (!this._enabled) return null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(this._endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this._timeoutMs),
        })
        if (!response.ok) {
          if (attempt === 0) {
            await delay(this._retryDelayMs)
            continue
          }
          this.ctx.logger.warn('feedback-submit: endpoint answered %d; dropping the submission', response.status)
          return null
        }
        const document: unknown = await response.json().catch(() => null)
        const id = typeof document === 'object' && document !== null && typeof (document as { id?: unknown }).id === 'string'
          ? (document as { id: string }).id
          : null
        return id === null ? null : { id }
      } catch (error: unknown) {
        if (attempt === 0) {
          await delay(this._retryDelayMs)
          continue
        }
        this.ctx.logger.warn('feedback-submit: submission failed:', error)
        return null
      }
    }
    return null
  }
}

/**
 * Mount the submit client as `ctx.feedbackSubmit`.
 * @param ctx - host context.
 * @param config - validated deployment choices.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.plugin(FeedbackSubmit, config)
}
