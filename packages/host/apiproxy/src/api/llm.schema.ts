/**
 * llm domain zod schemas (names derived from map keys: llmProvidersRequestSchema /
 * llmProvidersValueSchema / llmModelsRequestSchema / llmModelsValueSchema).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { ConfigurableProviderView, DiscoveredModelView } from './llm.ts'
import { modelCatalogFailureSchema, modelProviderGroupSchema } from './sessions.schema.ts'

/** ConfigurableProviderView row of llm.providers. */
export const configurableProviderViewSchema = z.object({
  provider: z.string().min(1),
  displayName: z.string().min(1),
  settingsNs: z.string(),
  settingsPath: z.array(z.string()),
  active: z.boolean(),
  declared: z.boolean().optional(),
}) satisfies z.ZodType<Wire<ConfigurableProviderView>>

/** llm.providers request payload. */
export const llmProvidersRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'llm.providers'>>>

/** llm.providers response value. */
export const llmProvidersValueSchema = z.object({
  providers: z.array(configurableProviderViewSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.providers'>>>

/** llm.models request payload. */
export const llmModelsRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'llm.models'>>>

/** llm.models response value. */
export const llmModelsValueSchema = z.object({
  groups: z.array(modelProviderGroupSchema),
  failures: z.array(modelCatalogFailureSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.models'>>>

/** DiscoveredModelView row of llm.discoverModels. */
export const discoveredModelViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
}) satisfies z.ZodType<Wire<DiscoveredModelView>>

/** llm.discoverModels request payload. */
export const llmDiscoverModelsRequestSchema = z.object({
  settingsNs: z.string().min(1),
  provider: z.string().min(1).optional(),
  baseURL: z.string().min(1).optional(),
  api: z.string().min(1).optional(),
  // Write-only at the host: used for this one interrogation, never stored and
  // never returned. It does ride the client's outgoing envelope like every
  // other secret-bearing payload (`credentials.set`, `settings.update`), which
  // `subscribeEnvelopes()` observers can see — redacting that tap is a
  // configuration-plane-wide change, not this method's to make alone.
  apiKey: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.discoverModels'>>>

/** llm.discoverModels response value. */
export const llmDiscoverModelsValueSchema = z.object({
  models: z.array(discoveredModelViewSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.discoverModels'>>>

/** PoolIdentityStatusView row. */
export const poolIdentityStatusViewSchema = z.object({
  id: z.string().min(1),
  credentialRef: z.string().min(1),
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
  cooldownUntil: z.number(),
  consecutiveFailures: z.number().int(),
  lastStatus: z.number().int().optional(),
  lastError: z.string().optional(),
  quota: z.object({
    remainingFraction: z.number().nullable().optional(),
    resetTime: z.union([z.string(), z.number()]).nullable().optional(),
    source: z.string().optional(),
  }).optional(),
}) satisfies z.ZodType<Wire<import('./llm.ts').PoolIdentityStatusView>>

/** llm.poolStatus request payload. */
export const llmPoolStatusRequestSchema = z.object({
  settingsNs: z.string().min(1),
  provider: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.poolStatus'>>>

/** llm.poolStatus response value. */
export const llmPoolStatusValueSchema = z.object({
  identities: z.array(poolIdentityStatusViewSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.poolStatus'>>>

/** llm.poolResetCooldown request payload. */
export const llmPoolResetCooldownRequestSchema = z.object({
  settingsNs: z.string().min(1),
  provider: z.string().min(1),
  identityId: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.poolResetCooldown'>>>

/** llm.poolResetCooldown response value. */
export const llmPoolResetCooldownValueSchema = z.object({
  ok: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.poolResetCooldown'>>>

/** llm.poolTestIdentity request payload. */
export const llmPoolTestIdentityRequestSchema = z.object({
  settingsNs: z.string().min(1),
  provider: z.string().min(1),
  identityId: z.string().min(1),
  apiKey: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.poolTestIdentity'>>>

/** llm.poolTestIdentity response value. */
export const llmPoolTestIdentityValueSchema = z.object({
  ok: z.boolean(),
  status: z.number().int().optional(),
  latencyMs: z.number().int().optional(),
  error: z.string().optional(),
  modelsCount: z.number().int().optional(),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.poolTestIdentity'>>>
