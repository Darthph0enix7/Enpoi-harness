/**
 * The compat-field vocabulary of every wire protocol a profile may configure.
 *
 * pi-ai's own compat types decide which switches exist; the disposition tables
 * below decide which of them a profile may set (`offer`) and which are
 * withheld because the installed catalog already decides them for the named
 * vendor. `catalog.ts` reads the tables to validate a route's settings, and
 * consumers outside this package — the heavy-provider manifest table — read
 * {@link offeredCompatFields} for the same vocabulary instead of restating
 * field names that would then drift.
 *
 * Only `type` imports reach pi-ai here, so a consumer may load this module
 * without pulling the provider runtime.
 *
 * @module dsh-llm-pi-ai/compat
 */

import type {
  AnthropicMessagesCompat,
  BedrockCompat,
  KnownApi,
  Model,
  OpenAICompletionsCompat,
  OpenAIResponsesCompat,
} from '@earendil-works/pi-ai'

/**
 * Whether one pi-ai compat field is configurable on a profile.
 *
 * `withhold` is the disposition for a field pi-ai's installed catalog already
 * sets for a named vendor. Reaching for one of those on a hand-declared route
 * means configuring a provider that should have been named as a catalog route
 * instead, where the installed entry carries the right value already.
 */
export type CompatDisposition = 'offer' | 'withhold'

/**
 * Disposition of every `OpenAICompletionsCompat` field. The `Record` key type
 * is a drift gate: a pi-ai upgrade that adds a field fails compilation here
 * until it is classified, so the offer never silently lags the upstream set.
 */
const COMPLETIONS_COMPAT_GATE = {
  supportsStore: 'offer',
  supportsDeveloperRole: 'offer',
  supportsReasoningEffort: 'offer',
  supportsUsageInStreaming: 'offer',
  supportsFinishReason: 'offer',
  maxTokensField: 'offer',
  requiresToolResultName: 'offer',
  requiresAssistantAfterToolResult: 'offer',
  requiresThinkingAsText: 'offer',
  requiresReasoningContentOnAssistantMessages: 'offer',
  thinkingFormat: 'offer',
  chatTemplateKwargs: 'offer',
  chatTemplateArgs: 'offer',
  supportsThinkingTokenBudget: 'offer',
  thinkingTokenBudgetField: 'offer',
  vllmPriority: 'offer',
  supportsStrictMode: 'offer',
  cacheControlFormat: 'offer',
  supportsLongCacheRetention: 'offer',
  openRouterRouting: 'withhold',
  vercelGatewayRouting: 'withhold',
  zaiToolStream: 'withhold',
  supportsOpenAIGrammarTools: 'withhold',
  sendSessionAffinityHeaders: 'withhold',
  deferredToolsMode: 'withhold',
  sessionAffinityFormat: 'withhold',
} as const satisfies Record<keyof OpenAICompletionsCompat, CompatDisposition>

/** Disposition of every `OpenAIResponsesCompat` field; a drift gate like the one above. */
const RESPONSES_COMPAT_GATE = {
  supportsDeveloperRole: 'offer',
  supportsMaxOutputTokens: 'offer',
  supportsStrictMode: 'offer',
  supportsLongCacheRetention: 'offer',
  sessionAffinityFormat: 'withhold',
  supportsOpenAIGrammarTools: 'withhold',
  supportsAdditionalTools: 'withhold',
  supportsToolSearch: 'withhold',
  supportsExplicitPromptCacheMode: 'withhold',
} as const satisfies Record<keyof OpenAIResponsesCompat, CompatDisposition>

/** Disposition of every `AnthropicMessagesCompat` field; a drift gate like the one above. */
const ANTHROPIC_COMPAT_GATE = {
  supportsEagerToolInputStreaming: 'offer',
  supportsLongCacheRetention: 'offer',
  supportsCacheControlOnTools: 'offer',
  supportsTemperature: 'offer',
  forceAdaptiveThinking: 'offer',
  allowEmptySignature: 'offer',
  supportsStrictTools: 'offer',
  sendSessionAffinityHeaders: 'withhold',
  supportsToolReferences: 'withhold',
  supportsMidConvoEffort: 'withhold',
  allowedFallbackModels: 'withhold',
} as const satisfies Record<keyof AnthropicMessagesCompat, CompatDisposition>

/** Disposition of every `BedrockCompat` field; a drift gate like the one above. */
const BEDROCK_COMPAT_GATE = {
  supportsStrictMode: 'offer',
} as const satisfies Record<keyof BedrockCompat, CompatDisposition>

/**
 * Every wire protocol pi-ai gives a compat type. Derived from `Model.compat`'s
 * own conditional rather than listed by hand, so a pi-ai release that gives a
 * further protocol a compat type fails the {@link COMPAT_GATES} entry list
 * until someone classifies its fields. A protocol pi-ai gives no compat type
 * resolves away here and takes no configured compat at all.
 */
type ApiWithCompat = { [K in KnownApi]: NonNullable<Model<K>['compat']> extends never ? never : K }[KnownApi]

/**
 * The compat gate of every wire protocol a profile may configure.
 *
 * Keyed by protocol, but grouped by pi-ai's compat *type*: the three Responses
 * protocols share `OpenAIResponsesCompat`, so a switch settable on one is
 * settable on all three. Keying by protocol alone would refuse
 * `azure-openai-responses` and `openai-codex-responses` the fields their own
 * models declare.
 */
const COMPAT_GATES: Readonly<Record<ApiWithCompat, Readonly<Record<string, CompatDisposition>>>> = {
  'openai-completions': COMPLETIONS_COMPAT_GATE,
  'openai-responses': RESPONSES_COMPAT_GATE,
  'azure-openai-responses': RESPONSES_COMPAT_GATE,
  'openai-codex-responses': RESPONSES_COMPAT_GATE,
  'anthropic-messages': ANTHROPIC_COMPAT_GATE,
  'bedrock-converse-stream': BEDROCK_COMPAT_GATE,
}

/**
 * The compat gate of one resolved protocol. A `string` lookup rather than a
 * keyed read: a route's `api` is configuration, so it may name a protocol
 * pi-ai gives no compat type — or none at all.
 * @param api - resolved wire protocol.
 * @returns that protocol's field gate, or `undefined` when it takes no compat.
 */
export function compatGate(api: string): Readonly<Record<string, CompatDisposition>> | undefined {
  return (COMPAT_GATES as Readonly<Record<string, Readonly<Record<string, CompatDisposition>>>>)[api]
}

/** The field names one gate offers. */
type OfferedIn<G> = { [K in keyof G]: G[K] extends 'offer' ? K : never }[keyof G]

/** Every compat field name a profile may set, on whichever protocol takes it. */
export type OfferedCompatField =
  | OfferedIn<typeof COMPLETIONS_COMPAT_GATE>
  | OfferedIn<typeof RESPONSES_COMPAT_GATE>
  | OfferedIn<typeof ANTHROPIC_COMPAT_GATE>
  | OfferedIn<typeof BEDROCK_COMPAT_GATE>

/**
 * Whether any wire protocol's compat type declares one field, whatever its
 * disposition. The diagnostic that runs before a protocol is known uses this
 * to tell a withheld field from a name no upstream compat type has.
 * @param field - configured compat field name.
 * @returns whether an upstream compat type declares the field.
 */
export function declaredCompatField(field: string): boolean {
  return Object.values(COMPAT_GATES).some(gate => gate[field] !== undefined)
}

/**
 * The protocols offering one compat field, in {@link COMPAT_GATES} order.
 * @param field - configured compat field name.
 * @returns the protocols whose compat takes it; empty when none does, which
 *   is either a withheld field or a name no upstream compat type declares.
 */
export function compatProtocols(field: string): readonly string[] {
  return Object.entries(COMPAT_GATES).flatMap(([api, gate]) => gate[field] === 'offer' ? [api] : [])
}

/**
 * The compat fields one protocol offers, for a diagnostic that has to show
 * what was available instead of the name that missed, and for a consumer that
 * declares switches before a route exists.
 * @param api - wire protocol.
 * @returns the offered field names, or an empty list for a protocol taking no compat.
 */
export function offeredCompatFields(api: string): readonly string[] {
  return Object.entries(compatGate(api) ?? {}).flatMap(([field, disposition]) => disposition === 'offer' ? [field] : [])
}

/**
 * Every offered field name, deduplicated, for the one diagnostic that cannot
 * narrow by protocol: the vocabulary check runs before any protocol resolves,
 * which is what lets it refuse a misspelling on a route whose models would
 * never have reached the protocol that declares the intended field.
 * @returns the offered field names across every protocol, in gate order.
 */
export function allOfferedCompatFields(): readonly string[] {
  const fields = new Set<string>()
  for (const api of Object.keys(COMPAT_GATES)) {
    for (const field of offeredCompatFields(api)) fields.add(field)
  }
  return [...fields]
}
