/**
 * `JinaFetchProvider`: a `WebFetchProvider` backed by Jina Reader
 * (`GET {baseURL}/<target-url>`), which fetches a page and returns its
 * LLM-friendly Markdown. Keyless requests work at Jina's anonymous rate limit;
 * a configured key switches to `Authorization: Bearer` for the higher quota.
 * Redirects fail before any `Location` target is contacted.
 * @module @deepseek-ai/dsh-web-fetch-jina/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchBody, WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { JinaEngine, JinaError } from './types.ts'

/** Stable id this provider registers under. */
export const JINA_PROVIDER_ID = 'jina'

/** Default Reader endpoint base; the target URL is appended as a path. */
export const JINA_DEFAULT_BASE_URL = 'https://r.jina.ai'

/**
 * Maximum accepted target URL length. It matches the sibling local HTTP fetch
 * provider so a URL the local backend refuses cannot slip through this one.
 */
export const JINA_MAX_URL_LENGTH = 2048

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Response header carrying Jina's output token count; read to derive a trim. */
const USAGE_TOKENS_HEADER = 'x-usage-tokens'

/** Resolved provider options (the plugin's `apply` supplies credential and constant defaults). */
export interface JinaFetchProviderOptions {
  /** Literal Jina API key; when present it wins over {@link resolveApiKey}. Omitted = keyless. */
  apiKey?: string
  /**
   * Resolve the current Jina API key for one fetch operation. A resolved key
   * switches the request to `Authorization: Bearer`; no key keeps the keyless
   * quota, so an absent resolver or an undefined result is not an error.
   */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by credential-resolution diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Endpoint base; the target URL is appended as a path. */
  baseURL: string
  /** Browser engine sent as `X-Engine`; omitted = Jina's automatic choice. */
  engine?: JinaEngine
  /** Page-load wait in seconds sent as `X-Timeout` (1–180). */
  timeoutSeconds?: number
  /**
   * Output-token cap sent as `X-Max-Tokens` (at least 500). Jina trims the
   * response at the cap instead of rejecting it; an output that reaches the
   * cap marks the result truncated.
   */
  maxTokens?: number
}

/**
 * Parse and bound a fetch request URL before prefixing the Reader endpoint.
 * Only http(s) targets are accepted. Jina performs the target fetch, so SSRF
 * screening moves to Jina for this provider; the local checks here are the
 * scheme and length bounds only.
 *
 * @param input - the raw target URL from the fetch request.
 * @returns the canonical target URL string appended to the endpoint base.
 */
export function validateJinaUrl(input: string): string {
  if (input.length > JINA_MAX_URL_LENGTH) {
    throw new WebError(`URL exceeds the maximum length of ${JINA_MAX_URL_LENGTH}`, 'WEB_INVALID_URL')
  }
  let url: URL
  try {
    url = new URL(input)
  } catch (error: unknown) {
    throw new WebError(`invalid URL: ${input}`, 'WEB_INVALID_URL', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`, 'WEB_INVALID_URL')
  }
  return url.toString()
}

/** Drop one trailing slash so the appended target never doubles it. */
function trimBase(baseURL: string): string {
  return baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL
}

/** True for an endpoint base this provider can call: a parseable http(s) URL. */
function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false
  const protocol = new URL(value).protocol
  return protocol === 'http:' || protocol === 'https:'
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * Derive Jina's server-side trim from its response headers instead of guessing
 * from the body length. With no configured cap Jina does not trim, and a
 * response that carries no `x-usage-tokens` cannot prove one, so both report
 * `false`; the README records that neither state rules out a Jina-side cut.
 */
function isTruncated(options: JinaFetchProviderOptions, headers: Headers): boolean {
  if (options.maxTokens === undefined) return false
  const usage = headers.get(USAGE_TOKENS_HEADER)
  if (usage === null) return false
  const tokens = Number(usage)
  return Number.isFinite(tokens) && tokens >= options.maxTokens
}

/** The Jina Reader fetch provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class JinaFetchProvider implements WebFetchProvider {
  readonly id = JINA_PROVIDER_ID

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted
   * once at each operation's entry so one fetch never mixes two sections. A
   * thunk rather than a value because the plugin's settings section can change
   * between fetches, and re-registering the provider to carry a new key or
   * endpoint would make the seam's selection observable to the user as a
   * flicker.
   */
  constructor(private readonly resolveOptions: () => JinaFetchProviderOptions) {}

  /** Usable while the endpoint base is a parseable http(s) URL; a key is optional. */
  available(): boolean {
    const options = this.resolveOptions()
    return isHttpUrl(options.baseURL)
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const options = this.resolveOptions()
    const target = validateJinaUrl(request.url)
    const apiKey = await this.apiKey(options)
    const headers: Record<string, string> = {
      'accept': 'text/plain',
      'user-agent': USER_AGENT,
    }
    if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`
    if (options.engine !== undefined) headers['x-engine'] = options.engine
    if (options.timeoutSeconds !== undefined) headers['x-timeout'] = String(options.timeoutSeconds)
    if (options.maxTokens !== undefined) headers['x-max-tokens'] = String(options.maxTokens)
    let response: Response
    try {
      response = await fetch(`${trimBase(options.baseURL)}/${target}`, {
        method: 'GET',
        redirect: 'error',
        headers,
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Jina fetch aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Jina fetch request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Jina Reader error (HTTP ${status})`
      try {
        const parsed = await response.json() as JinaError
        const detail = parsed.message ?? parsed.readableMessage
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (isAbortError(error)) throw new WebError('Jina fetch aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the status line is already captured in `message` above; a
        // malformed/non-JSON refusal body can only cost a richer detail.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    let content: string
    try {
      content = await response.text()
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Jina fetch aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Jina returned an unreadable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    const body: WebFetchBody = { kind: 'text', content }
    return {
      url: target,
      statusCode: response.status,
      body,
      truncated: isTruncated(options, response.headers),
    }
  }

  /**
   * Resolve one operation's credential without retaining it on the provider.
   * Jina works keyless, so a missing key is a valid anonymous request; only a
   * resolver failure is an error.
   * @param options - the caller's snapshot, so the key and the endpoint it is sent to come from one section.
   * @returns the resolved key, or `undefined` to send a keyless request.
   */
  private async apiKey(options: JinaFetchProviderOptions): Promise<string | undefined> {
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    let resolved: string | undefined
    try {
      resolved = await options.resolveApiKey?.()
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Jina fetch aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(
        `Jina fetch credential resolution failed: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
    return resolved !== undefined && resolved.length > 0 ? resolved : undefined
  }
}
