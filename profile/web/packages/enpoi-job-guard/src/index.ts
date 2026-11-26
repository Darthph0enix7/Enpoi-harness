/**
 * `enpoi-job-guard` — fail-closed job admission, step/wall/token/tool-call
 * budgets, durable audit, and effective profile identity for background worker
 * sessions.
 *
 * Namespace plugin (named exports, no default export).
 *
 * @module dsh-enpoi-job-guard
 */

import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { JobGuardRuntime } from './guard.ts'
import type { Config as JobGuardConfig, PeerJobBindingsService, PeerProfileIdentityService, ResolvedJobGuardConfig } from './types.ts'

export { JOB_BUDGET_REFUSED_CODE, JobGuardRuntime } from './guard.ts'
export { canonicalJson, encodeAuditSegment, hashArguments, sha256Hex, writeDurableAudit } from './audit.ts'
export type {
  JobGuardAuditRecord,
  JobGuardBudgetStopRecord,
  McpHeaderProviderService,
  PeerJobBinding,
  PeerJobBindingsService,
  PeerProfileIdentityDescription,
  PeerProfileIdentityService,
  ResolvedJobGuardConfig,
} from './types.ts'

export type Config = JobGuardConfig

/** Cordis plugin name. */
export const name = 'enpoi-job-guard'

/** Tool runtime is required for pre-execute and monotonic guard registration. */
export const inject = ['tools']

/** Default maximum model steps per job when omitted by binding and config. */
export const DEFAULT_MAX_STEPS = 32
/** Default maximum tool calls per job when omitted by binding and config. */
export const DEFAULT_MAX_TOOL_CALLS = 64
/** Default maximum wall-clock duration in milliseconds (10 minutes). */
export const DEFAULT_MAX_WALL_MS = 600_000
/** Default maximum total tokens per job. */
export const DEFAULT_MAX_TOTAL_TOKENS = 200_000
/** Default output token reservation when `maxTokens` is omitted on an LLM call. */
export const DEFAULT_MAX_TOKENS_RESERVE = 4_096
/** Default hub admission HTTP timeout in milliseconds. */
export const DEFAULT_ADMISSION_TIMEOUT_MS = 5_000
/** Default `mcpHeaderProvider` server id used for hub admission requests. */
export const DEFAULT_ADMISSION_SERVER_ID = 'job-guard-admission'
/** Default maximum bytes per session audit file (1 MiB). */
export const DEFAULT_AUDIT_MAX_BYTES = 1_048_576
/** Minimum accepted `auditMaxBytes` floor (one sanitized record needs room). */
export const MIN_AUDIT_MAX_BYTES = 128

/** Schemastery schema for {@link Config}. */
export const Config: Schema<Config> = Schema.object({
  requireBinding: Schema.boolean().default(true),
  requirePinnedRoute: Schema.boolean().default(true),
  allowedTools: Schema.array(Schema.string().min(1)),
  toolCapabilities: Schema.dict(Schema.string().min(1)).default({}),
  defaultCapability: Schema.string().min(1),
  maxSteps: Schema.natural().min(1).default(DEFAULT_MAX_STEPS),
  maxToolCalls: Schema.natural().min(1).default(DEFAULT_MAX_TOOL_CALLS),
  maxWallMs: Schema.natural().min(1).default(DEFAULT_MAX_WALL_MS),
  maxTotalTokens: Schema.natural().min(1).default(DEFAULT_MAX_TOTAL_TOKENS),
  defaultMaxTokensReserve: Schema.natural().min(1).default(DEFAULT_MAX_TOKENS_RESERVE),
  admissionUrl: Schema.string().min(1),
  admissionTimeoutMs: Schema.natural().min(1).default(DEFAULT_ADMISSION_TIMEOUT_MS),
  admissionServerId: Schema.string().min(1).default(DEFAULT_ADMISSION_SERVER_ID),
  admissionIncludeArgs: Schema.boolean().default(false),
  auditDir: Schema.string().min(1),
  auditMaxBytes: Schema.natural().min(MIN_AUDIT_MAX_BYTES).default(DEFAULT_AUDIT_MAX_BYTES),
  presetId: Schema.string().default('worker'),
  harnessVersion: Schema.string().min(1),
  expectedFence: Schema.union([Schema.string().min(1), Schema.natural().min(1)]),
  instanceId: Schema.string().min(1),
})

function assertPositiveInt(value: number | undefined, field: string, min: number = 1): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < min) {
    throw new Error(`enpoi-job-guard: ${field} must be an integer >= ${String(min)}`)
  }
  return value
}

/**
 * Validate and resolve raw plugin Config (failing loud on any misconfiguration,
 * including programmatic construction that bypassed Schemastery).
 * @param raw - raw plugin configuration.
 * @returns immutable resolved configuration.
 */
export function resolveJobGuardConfig(raw: Config = {}): ResolvedJobGuardConfig {
  const requireBinding = raw.requireBinding ?? true
  if (typeof requireBinding !== 'boolean') {
    throw new Error('enpoi-job-guard: requireBinding must be a boolean')
  }
  const requirePinnedRoute = raw.requirePinnedRoute ?? true
  if (typeof requirePinnedRoute !== 'boolean') {
    throw new Error('enpoi-job-guard: requirePinnedRoute must be a boolean')
  }

  let allowedTools: readonly string[] | undefined
  if (raw.allowedTools !== undefined) {
    if (!Array.isArray(raw.allowedTools)) {
      throw new Error('enpoi-job-guard: allowedTools must be an array of non-empty strings')
    }
    const seen = new Set<string>()
    for (const item of raw.allowedTools) {
      if (typeof item !== 'string' || item.length === 0) {
        throw new Error('enpoi-job-guard: allowedTools entries must be non-empty strings')
      }
      if (seen.has(item)) {
        throw new Error(`enpoi-job-guard: allowedTools contains duplicate entry "${item}"`)
      }
      seen.add(item)
    }
    allowedTools = Object.freeze([...raw.allowedTools])
  }

  const toolCapabilitiesRaw = raw.toolCapabilities ?? {}
  if (typeof toolCapabilitiesRaw !== 'object' || toolCapabilitiesRaw === null || Array.isArray(toolCapabilitiesRaw)) {
    throw new Error('enpoi-job-guard: toolCapabilities must be a plain object')
  }
  const capabilityEntries: Array<[string, string]> = []
  for (const [k, v] of Object.entries(toolCapabilitiesRaw)) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`enpoi-job-guard: toolCapabilities["${k}"] must be a non-empty string`)
    }
    capabilityEntries.push([k, v])
  }

  if (raw.defaultCapability !== undefined && (typeof raw.defaultCapability !== 'string' || raw.defaultCapability.length === 0)) {
    throw new Error('enpoi-job-guard: defaultCapability must be a non-empty string')
  }

  let admissionUrl: string | undefined
  if (raw.admissionUrl !== undefined) {
    if (typeof raw.admissionUrl !== 'string' || raw.admissionUrl.length === 0) {
      throw new Error('enpoi-job-guard: admissionUrl must be a non-empty HTTP(S) URL')
    }
    let parsed: URL
    try {
      parsed = new URL(raw.admissionUrl)
    } catch {
      throw new Error('enpoi-job-guard: admissionUrl is not a valid URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`enpoi-job-guard: admissionUrl must use http: or https: (got ${parsed.protocol})`)
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('enpoi-job-guard: admissionUrl must not contain credentials, a query, or a fragment')
    }
    admissionUrl = parsed.toString()
  }

  const admissionIncludeArgs = raw.admissionIncludeArgs ?? false
  if (typeof admissionIncludeArgs !== 'boolean') {
    throw new Error('enpoi-job-guard: admissionIncludeArgs must be a boolean')
  }

  const admissionServerId = raw.admissionServerId ?? DEFAULT_ADMISSION_SERVER_ID
  if (typeof admissionServerId !== 'string' || admissionServerId.length === 0) {
    throw new Error('enpoi-job-guard: admissionServerId must be a non-empty string')
  }

  const auditDir = raw.auditDir ?? join(resolveDshHome(), 'enpoi-job-guard')
  if (!isAbsolute(auditDir)) {
    throw new Error('enpoi-job-guard: auditDir must be an absolute path')
  }

  const presetId = raw.presetId ?? 'worker'
  if (typeof presetId !== 'string') {
    throw new Error('enpoi-job-guard: presetId must be a string')
  }

  const harnessVersion = raw.harnessVersion ?? getDshRuntimeVersion()
  if (typeof harnessVersion !== 'string' || harnessVersion.length === 0) {
    throw new Error('enpoi-job-guard: harnessVersion must be a non-empty string')
  }

  const admissionTimeoutMs = assertPositiveInt(raw.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS, 'admissionTimeoutMs')
  if (admissionTimeoutMs > 2_147_483_647) throw new Error('enpoi-job-guard: admissionTimeoutMs exceeds timer range')
  return Object.freeze({
    requireBinding,
    requirePinnedRoute,
    allowedTools,
    toolCapabilities: Object.freeze(Object.fromEntries(capabilityEntries)),
    defaultCapability: raw.defaultCapability,
    maxSteps: assertPositiveInt(raw.maxSteps ?? DEFAULT_MAX_STEPS, 'maxSteps'),
    maxToolCalls: assertPositiveInt(raw.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS, 'maxToolCalls'),
    maxWallMs: assertPositiveInt(raw.maxWallMs ?? DEFAULT_MAX_WALL_MS, 'maxWallMs'),
    maxTotalTokens: assertPositiveInt(raw.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS, 'maxTotalTokens'),
    defaultMaxTokensReserve: assertPositiveInt(raw.defaultMaxTokensReserve ?? DEFAULT_MAX_TOKENS_RESERVE, 'defaultMaxTokensReserve'),
    admissionUrl,
    admissionTimeoutMs,
    admissionServerId,
    admissionIncludeArgs,
    auditDir,
    auditMaxBytes: assertPositiveInt(raw.auditMaxBytes ?? DEFAULT_AUDIT_MAX_BYTES, 'auditMaxBytes', MIN_AUDIT_MAX_BYTES),
    presetId,
    harnessVersion,
    expectedFence: raw.expectedFence,
    instanceId: raw.instanceId,
  })
}

/**
 * Mount the `enpoi-job-guard` enforcement listeners, monotonic tool guard,
 * and `peerProfileIdentity` service on `ctx`.
 * @param ctx - plugin context.
 * @param config - raw plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveJobGuardConfig(config)
  const runtime = new JobGuardRuntime(ctx, resolved)

  const identityService: PeerProfileIdentityService = {
    describe: (sessionId: SessionId) => runtime.describeProfileIdentity(sessionId),
  }
  ctx.effect(() => {
    ctx.provide('peerProfileIdentity', identityService)
    const disposeGuard = ctx.tools.guard(exec => runtime.checkToolGuard(exec))
    const disposePreExecute = ctx.on(
      'tools/pre-execute',
      (exec, next) => runtime.handlePreExecute(exec, next),
      { prepend: true },
    )
    const disposeDispatch = ctx.on('tools/execute', (exec, next) => runtime.handleDispatch(exec, next), { prepend: true })
    const disposePreStep = ctx.on(
      'agent/pre-step',
      (payload, next) => runtime.handlePreStep(payload, next),
      { prepend: true },
    )
    const disposeLlmStream = ctx.on(
      'llm/stream',
      (options, next) => runtime.handleLlmStream(options, next),
      { prepend: true },
    )
    const disposeRequest = ctx.on('agent/request', async ({ agent }, next) => {
      const request = await next()
      const bindings = ctx.get('peerJobBindings') as PeerJobBindingsService | undefined
      if (!resolved.requireBinding && bindings?.get(agent.id) === undefined) return request
      return request.maxTokens === undefined ? { ...request, maxTokens: resolved.defaultMaxTokensReserve } : request
    }, { prepend: true })
    const disposeSessionDisposed = ctx.on('session/disposed', (session) => {
      runtime.forgetSession(session.id)
    })

    return () => {
      disposeGuard()
      disposePreExecute()
      disposeDispatch()
      disposePreStep()
      disposeLlmStream()
      disposeRequest()
      disposeSessionDisposed()
      runtime.dispose()
    }
  }, 'enpoi-job-guard.hooks')

  // Inventory check only: the monotonic guard above is the dispatcher veto,
  // including for tools that register after this check.
  const registeredTools = ctx.tools.schemas().map(t => t.name)
  if (resolved.allowedTools !== undefined) {
    const allowedSet = new Set(resolved.allowedTools)
    const extraTools = registeredTools.filter(toolName => !allowedSet.has(toolName))
    if (extraTools.length > 0) {
      ctx.logger.warn(
        `enpoi-job-guard: ${String(extraTools.length)} registered tool(s) sit outside guard Config allowedTools and will be denied at execution: ${extraTools.join(', ')}`,
      )
    }
  }
}
