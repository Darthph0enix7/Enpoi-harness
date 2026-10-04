/**
 * Command Code adapter for the harness LLM seam.
 *
 * Registered with `ctx.llm.registerAdapter()` like any other adapter — the
 * seam has no protocol table, so a bespoke wire protocol is a first-class
 * citizen. Requests go to `POST {baseURL}/alpha/generate`; the route's baseURL
 * points at the local keypool (`http://127.0.0.1:8899/commandcode`), which
 * injects the Command Code CLI headers and rotates the real keys. This
 * adapter therefore sends no CLI header and never touches a vendor key.
 *
 * Capabilities come exclusively from the route's catalog
 * (`{baseURL}/catalog.json`, fetched at startup); user-attached images are
 * resolved from the harness attachment service through the route's
 * request-sized reader (the `store.readImageRequest` pixel/byte target), and
 * tool-result images keep their stored bytes before the converter hoists them
 * into a following user message.
 *
 * @module dsh-enpoi-commandcode-provider/adapter
 */

import type { ImageAttachmentRef, ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type {
  GenerateOptions,
  ImageAttachmentAccess,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { attributionHeaders, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { CatalogEntry } from './catalog.js'
import { CatalogStore, contextWindowOf, effortsOf, entryFor, modalitiesOf, visionOf } from './catalog.js'
import type { CcInputMessage, CcInputPart, CcTool } from './convert.js'
import { buildRequest } from './convert.js'
import { classifyCommandCodeError } from './errors.js'
import { parseCommandCodeStream } from './stream.js'

/** One route this adapter serves, as written by the heavy-provider flow. */
export interface CommandCodeRouteProfile {
  /** Provider route key (`commandcode`). */
  route: string
  displayName: string
  /** Keypool base URL, e.g. `http://127.0.0.1:8899/commandcode`. */
  baseURL: string
  /** Credential reference when the route is BYOK; absent for the keypool. */
  apiKeyEnv?: string
  /** Keypool routes are keyless: the proxy supplies the Authorization header. */
  keyless: boolean
  /** Models the route writer discovered; the catalog supersedes them. */
  models?: readonly { id: string; name?: string }[]
  /** Total-pixel budget for one user-attached request image. */
  userImageMaxPixels: number
  /** Encoded-byte target for one user-attached request image. */
  userImageMaxBytes: number
}

/** Request-size budget for user-attached images on one route. */
export interface CcUserImageBudget {
  /** Total-pixel budget; larger sources are downscaled proportionally. */
  maxPixels: number
  /** Encoded-byte target of one request image. */
  maxBytes: number
}

/** Default total-pixel budget for user-attached request images (2048x2048, mirroring the pi-ai route default). */
export const DEFAULT_USER_IMAGE_MAX_PIXELS = 2048 * 2048
/** Default encoded-byte target for one user-attached request image, before base64 expansion. */
export const DEFAULT_USER_IMAGE_MAX_BYTES = 1024 * 1024

/** Constructor inputs the owning plugin supplies. */
export interface CommandCodeAdapterOptions {
  /** Current route profiles by provider route key. */
  profiles: () => ReadonlyMap<string, CommandCodeRouteProfile>
  /** Catalog store for one route, created and started by the plugin. */
  catalogFor: (profile: CommandCodeRouteProfile) => CatalogStore
  /** Resolve the route credential; called once per stream call. */
  resolveApiKey: (profile: CommandCodeRouteProfile) => Promise<string | undefined>
  /** Read one durable image attachment's stored bytes for a tool-result inline data URI. */
  readImage?: (ref: ImageAttachmentRef, signal?: AbortSignal) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** Read one durable user-attached image at the route's request size for an inline data URI. */
  readUserImage?: (
    ref: ImageAttachmentRef,
    target: ImageRequestTarget,
    signal?: AbortSignal,
  ) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch
  /** Injectable clock for the envelope's date. */
  now?: () => Date
}

/** Request timeout for one `/alpha/generate` call. */
const REQUEST_TIMEOUT_MS = 300_000

function toolNameOf(options: GenerateOptions): Map<string, string> {
  const names = new Map<string, string>()
  for (const message of options.messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type === 'tool-call') names.set(block.id, block.name)
    }
  }
  return names
}

/** The harness tool declarations mapped to the Command Code wire shape. */
export function toCcTools(tools: readonly ToolSchema[] | undefined): CcTool[] {
  return (tools ?? []).map(tool => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }))
}

/** Deterministic request target for one source under the route's user-image budget. */
function userImageTarget(ref: ImageAttachmentRef, budget: CcUserImageBudget): ImageRequestTarget {
  return { ...requestImageDimensions(ref.width, ref.height, budget.maxPixels), maxBytes: budget.maxBytes }
}

/**
 * Convert one harness request into wire messages, resolving image blocks
 * through the attachment service. User-attached images use the route's
 * request-sized reader when supplied; tool-result images keep their stored
 * bytes. Every unresolved image degrades to a text note; raw bytes are never
 * inlined as text.
 */
export async function toCcMessages(
  options: GenerateOptions,
  readImage: CommandCodeAdapterOptions['readImage'],
  readUserImage?: CommandCodeAdapterOptions['readUserImage'],
  userImageBudget?: CcUserImageBudget,
): Promise<CcInputMessage[]> {
  const messages: CcInputMessage[] = []
  for (const message of options.messages) {
    if (message.role === 'system' || message.role === 'developer') continue
    if (message.role === 'user') {
      const parts: CcInputPart[] = []
      for (const block of message.content) {
        switch (block.type) {
          case 'text':
            parts.push({ type: 'text', text: block.text })
            break
          case 'image': {
            if (block.offloaded === true) {
              parts.push({ type: 'text', text: '[image omitted to fit request image limits]' })
              break
            }
            const resolved = readUserImage === undefined || userImageBudget === undefined
              ? await readImage?.(block.attachment, options.signal)
              : await readUserImage(block.attachment, userImageTarget(block.attachment, userImageBudget), options.signal)
            if (resolved === undefined) {
              parts.push({
                type: 'text',
                text: `[image omitted: ${block.attachment.mediaType} — the attachment service could not read it]`,
              })
              break
            }
            parts.push({
              type: 'file',
              mediaType: resolved.mediaType,
              data: `data:${resolved.mediaType};base64,${Buffer.from(resolved.data).toString('base64')}`,
            })
            break
          }
          case 'file':
            parts.push({ type: 'text', text: `[file attachment: ${block.attachment.name ?? 'unnamed'}]` })
            break
          default:
            break
        }
      }
      messages.push({ role: 'user', content: parts })
      continue
    }
    if (message.role === 'assistant') {
      const parts: CcInputPart[] = []
      for (const block of message.content) {
        if (block.type === 'text') parts.push({ type: 'text', text: block.text })
        else if (block.type === 'reasoning') parts.push({ type: 'reasoning', text: block.text })
        else if (block.type === 'tool-call') {
          parts.push({ type: 'tool-call', toolCallId: block.id, toolName: block.name, arguments: block.arguments })
        }
      }
      if (parts.length > 0) messages.push({ role: 'assistant', content: parts })
      continue
    }
    // tool
    const parts: CcInputPart[] = []
    for (const block of message.content) {
      if (block.type === 'text') parts.push({ type: 'text', text: block.text })
      else if (block.type === 'image') {
        if (block.offloaded === true) {
          parts.push({ type: 'text', text: '[image omitted to fit request image limits]' })
          continue
        }
        const resolved = readImage === undefined ? undefined : await readImage(block.attachment, options.signal)
        if (resolved === undefined) {
          parts.push({
            type: 'text',
            text: `[image omitted: ${block.attachment.mediaType} — the attachment service could not read it]`,
          })
          continue
        }
        // The converter hoists this out of the tool result into a following
        // user message; here it only has to be recognizable as binary.
        parts.push({
          type: 'file',
          mediaType: resolved.mediaType,
          data: `data:${resolved.mediaType};base64,${Buffer.from(resolved.data).toString('base64')}`,
        })
      }
    }
    messages.push({ role: 'tool', content: parts, toolCallId: message.toolCallId, isError: message.isError === true })
  }
  return messages
}

/**
 * Command Code adapter. Each operation reads the current route profiles, so a
 * settings change reaches the next request without a restart.
 */
export class CommandCodeAdapter extends LlmAdapter {
  constructor(private readonly options: CommandCodeAdapterOptions) {
    super()
  }

  private profileOf(provider: string): CommandCodeRouteProfile {
    const profile = this.options.profiles().get(provider)
    if (profile === undefined) throw new LlmError(`Command Code adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    return profile
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.options.profiles().get(provider)?.displayName ?? provider }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const profile = this.profileOf(provider)
    const entries = await this.options.catalogFor(profile).entries()
    if (entries.length > 0) {
      return entries.map(entry => ({
        provider,
        id: entry.id,
        name: entry.name,
        ...modalitiesOf(entry) === undefined ? {} : { inputModalities: modalitiesOf(entry) },
      }))
    }
    return (profile.models ?? []).map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
    }))
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const profile = this.profileOf(provider)
    const entries = await this.options.catalogFor(profile).entries()
    const entry: CatalogEntry | undefined = entryFor(entries, model)
    const efforts = effortsOf(entry)
    const context = contextWindowOf(entry)
    return {
      provider,
      id: model,
      name: entry?.name ?? model,
      ...modalitiesOf(entry) === undefined ? {} : { inputModalities: modalitiesOf(entry) },
      ...context === undefined ? {} : { context: { contextWindow: context } },
      ...efforts.length === 0
        ? {}
        : {
            reasoning: {
              efforts: efforts.map(effort => ({ id: effort as never, name: effort })),
            },
          },
    }
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    }
  }

  async * stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const profile = this.profileOf(options.provider)
    const catalog = this.options.catalogFor(profile)
    const entries = await catalog.entries()
    const entry = entryFor(entries, options.model)

    const effort = options.reasoningEffort
    if (effort !== undefined) {
      const supported = effortsOf(entry)
      if (supported.length > 0 && !supported.includes(effort)) {
        throw new LlmError(
          `Command Code model "${options.model}" does not support reasoning effort "${effort}"`
          + ` (catalog offers: ${supported.join(', ')})`,
          'UNSUPPORTED_REASONING_EFFORT',
        )
      }
    }

    const key = profile.keyless ? undefined : await this.options.resolveApiKey(profile)
    if (!profile.keyless && key === undefined) {
      throw new LlmError(
        `Command Code route "${options.provider}" resolves ${profile.apiKeyEnv ?? 'no credential'}, which is not set`,
        'MISSING_CREDENTIAL',
      )
    }

    const messages = await toCcMessages(options, this.options.readImage, this.options.readUserImage, {
      maxPixels: profile.userImageMaxPixels,
      maxBytes: profile.userImageMaxBytes,
    })
    const envelope = buildRequest({
      model: options.model,
      messages,
      tools: toCcTools(options.tools),
      ...options.system === undefined ? {} : { system: options.system },
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      ...effort === undefined ? {} : { reasoningEffort: effort },
      visionEnabled: visionOf(entry),
      ...this.options.now === undefined ? {} : { now: this.options.now() },
    })

    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
    let response: Response
    try {
      response = await fetchImpl(`${profile.baseURL.replace(/\/+$/, '')}/alpha/generate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...attributionHeaders(),
          ...key === undefined ? {} : { authorization: `Bearer ${key}` },
        },
        body: JSON.stringify(envelope),
        signal,
      })
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw new LlmError('Command Code request aborted by caller', 'ABORTED', { cause: error })
      }
      throw new LlmError(
        `Command Code transport failure: ${error instanceof Error ? error.message : String(error)}`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      const failure = classifyCommandCodeError(response.status, body)
      throw new LlmError(`Command Code API error (${String(response.status)}): ${failure.message}`, failure.code)
    }
    if (response.body === null) {
      throw new LlmError('Command Code API returned no response body', 'SERVER')
    }
    yield * parseCommandCodeStream(response.body)
  }
}
