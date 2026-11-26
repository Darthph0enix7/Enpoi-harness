/**
 * Core enforcement logic for `enpoi-job-guard`: pre-execute admission, atomic
 * counters, deadline-bound hub admission, pre-step limits, preventive LLM
 * token budgeting, and profile identity hashing.
 *
 * @module dsh-enpoi-job-guard/guard
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { HarnessError, LlmError, type GenerateOptions, type Message, type StreamChunk, type ToolSchema, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { PreToolDecision, ToolDispatchExecution, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { canonicalJson, hashArguments, sha256Hex, writeDurableAudit } from './audit.ts'
import type {
  McpHeaderProviderService,
  RuntimePeerJobBinding as PeerJobBinding,
  PeerJobBindingsService,
  PeerProfileIdentityDescription,
  ResolvedJobGuardConfig,
} from './types.ts'

/** Error code raised on `llm/stream` when a job exceeds or cannot meter its budget. */
export const JOB_BUDGET_REFUSED_CODE = 'JOB_BUDGET_REFUSED'

interface SessionGuardState {
  jobId: string
  fence: string
  instanceId: string
  toolCallsUsed: number
  stepsUsed: number
  inFlightReservedTokens: number
  highWaterMeteredTokens: number
}

interface TokenMeterLike {
  estimateMessage(message: Message): number
}

interface SessionProjectionsLike {
  snapshot(session: Session, keys?: readonly string[]): {
    values: {
      modelSelection?: { next: { provider: string; model: string; chain?: string } | null }
      tokenUsage?: {
        uncachedInputTokens: number
        outputTokens: number
        cacheReadTokens: number
        cacheWriteTokens: number
      }
    }
  }
}

interface SessionsLookupLike {
  get(id: SessionId): Session | undefined
}

interface AgentsLookupLike {
  get(id: SessionId): Agent | undefined
}

type BindingResolution =
  | { ok: true; binding: PeerJobBinding; state: SessionGuardState; remainingWallMs: number }
  | { ok: false; unbound: boolean; reasonCode: string; message: string; jobId: string; fence: string | number }

/**
 * Stateful per-process job guard coordinating tool admission, step/wall limits,
 * LLM token reservations, durable audit, and profile identity hashing.
 */
export class JobGuardRuntime {
  private readonly sessionStates = new Map<string, SessionGuardState>()
  private readonly configDigest: string
  private readonly auditChains = new Map<string, Promise<void>>()
  private readonly admitted = new WeakMap<ToolExecution, string>()

  /**
   * @param ctx - Cordis plugin context.
   * @param config - validated, resolved guard configuration.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedJobGuardConfig,
  ) {
    this.configDigest = sha256Hex(canonicalJson({
      requireBinding: config.requireBinding,
      requirePinnedRoute: config.requirePinnedRoute,
      allowedTools: config.allowedTools === undefined ? null : [...config.allowedTools].sort(),
      toolCapabilities: config.toolCapabilities,
      defaultCapability: config.defaultCapability ?? null,
      maxSteps: config.maxSteps,
      maxToolCalls: config.maxToolCalls,
      maxWallMs: config.maxWallMs,
      maxTotalTokens: config.maxTotalTokens,
      defaultMaxTokensReserve: config.defaultMaxTokensReserve,
      admissionOrigin: sanitizeUrlForDigest(config.admissionUrl),
      admissionTimeoutMs: config.admissionTimeoutMs,
      admissionServerId: config.admissionServerId,
      admissionIncludeArgs: config.admissionIncludeArgs,
      auditMaxBytes: config.auditMaxBytes,
      expectedFence: config.expectedFence,
      instanceId: config.instanceId,
    }))
  }

  /**
   * Clear tracked session state when a session is disposed.
   * @param sessionId - disposed session id.
   */
  forgetSession(sessionId: string): void {
    this.sessionStates.delete(sessionId)
    this.auditChains.delete(sessionId)
  }

  /**
   * Clear all in-memory state on plugin disposal.
   */
  dispose(): void {
    this.sessionStates.clear()
    this.auditChains.clear()
  }

  /**
   * Serialize per-session audit writes so concurrent batches never race size
   * checks or append ordering on the `0600` file.
   */
  private enqueueAudit(
    sessionKey: string,
    record: Parameters<typeof writeDurableAudit>[1],
  ): Promise<void> {
    const prior = this.auditChains.get(sessionKey) ?? Promise.resolve()
    const next = prior.then(() =>
      writeDurableAudit({
        auditDir: this.config.auditDir,
        auditMaxBytes: this.config.auditMaxBytes,
        sessionKey,
      }, record),
    )
    this.auditChains.set(sessionKey, next.catch(() => undefined))
    return next
  }

  private resolveBinding(sessionId: string | undefined, now: number): BindingResolution {
    if (sessionId === undefined || sessionId.length === 0) {
      return {
        ok: false,
        unbound: !this.sessionStates.has(sessionId ?? ''),
        reasonCode: 'BINDING_MISSING',
        message: 'worker execution denied: no bound session id',
        jobId: 'unbound',
        fence: 'none',
      }
    }
    const bindings = this.ctx.get('peerJobBindings') as PeerJobBindingsService | undefined
    if (bindings === undefined || typeof bindings.get !== 'function') {
      return {
        ok: false,
        unbound: !this.sessionStates.has(sessionId),
        reasonCode: 'BINDING_SERVICE_MISSING',
        message: 'worker execution denied: job bindings service is unavailable',
        jobId: 'unbound',
        fence: 'none',
      }
    }
    const binding = bindings.get(sessionId as SessionId)
    if (binding === undefined) {
      return {
        ok: false,
        unbound: !this.sessionStates.has(sessionId),
        reasonCode: 'BINDING_MISSING',
        message: 'worker execution denied: session has no active job binding',
        jobId: 'unbound',
        fence: 'none',
      }
    }
    const jobId = typeof binding.jobId === 'string' && binding.jobId.length > 0 ? binding.jobId : 'invalid'
    const fence = (typeof binding.fence === 'string' ? binding.fence.length > 0 : Number.isSafeInteger(binding.fence) && binding.fence > 0)
      ? binding.fence : 'invalid'
    if (binding.revoked === true || binding.revokedAt !== undefined) {
      return {
        ok: false,
        unbound: false,
        reasonCode: 'JOB_REVOKED',
        message: 'worker execution denied: job binding has been revoked',
        jobId,
        fence,
      }
    }
    if (binding.sessionId !== sessionId || jobId === 'invalid'
      || fence === 'invalid'
      || !Number.isFinite(binding.expiresAt)
      || !Number.isFinite(binding.createdAt)
      || !Array.isArray(binding.capabilities)) {
      return {
        ok: false,
        unbound: false,
        reasonCode: 'BINDING_INVALID',
        message: 'worker execution denied: malformed job binding',
        jobId,
        fence,
      }
    }
    if (this.config.expectedFence !== undefined && binding.fence !== this.config.expectedFence) {
      return {
        ok: false,
        unbound: false,
        reasonCode: 'FENCE_MISMATCH',
        message: 'worker execution denied: job fence mismatch',
        jobId,
        fence,
      }
    }
    if (this.config.instanceId !== undefined && binding.instanceId !== this.config.instanceId) {
      return {
        ok: false,
        unbound: false,
        reasonCode: 'INSTANCE_MISMATCH',
        message: 'worker execution denied: worker instance mismatch',
        jobId,
        fence,
      }
    }
    if (now >= binding.expiresAt) {
      return {
        ok: false,
        unbound: false,
        reasonCode: 'JOB_EXPIRED',
        message: 'worker execution denied: job binding expired',
        jobId,
        fence,
      }
    }
    const maxWallMs = effectiveLimit(binding.limits.maxWallMs, this.config.maxWallMs)
    const wallDeadline = Math.min(binding.expiresAt, binding.createdAt + maxWallMs)
    if (now >= wallDeadline) {
      return {
        ok: false,
        unbound: false,
        reasonCode: 'WALL_DEADLINE_EXCEEDED',
        message: 'worker execution denied: job wall-clock deadline exceeded',
        jobId,
        fence,
      }
    }
    let state = this.sessionStates.get(sessionId)
    if (state === undefined) {
      state = {
        jobId: binding.jobId,
        fence: canonicalJson(binding.fence),
        instanceId: binding.instanceId,
        toolCallsUsed: 0,
        stepsUsed: 0,
        inFlightReservedTokens: 0,
        highWaterMeteredTokens: 0,
      }
      this.sessionStates.set(sessionId, state)
    } else if (state.jobId !== binding.jobId || state.fence !== canonicalJson(binding.fence) || state.instanceId !== binding.instanceId) {
      return {
        ok: false,
        unbound: false,
        reasonCode: 'FENCE_MISMATCH',
        message: 'worker execution denied: session job or fence changed',
        jobId: binding.jobId,
        fence: binding.fence,
      }
    }
    return { ok: true, binding, state, remainingWallMs: wallDeadline - now }
  }

  private toolAllowed(binding: PeerJobBinding, name: string): boolean {
    return (this.config.allowedTools?.includes(name) ?? false) && (binding.allowedToolNames?.includes(name) ?? false)
  }

  private resolveRequiredCapability(toolName: string, binding: PeerJobBinding): string | undefined {
    const mapped = this.config.toolCapabilities[toolName] ?? this.config.defaultCapability ?? toolName
    return binding.capabilities.includes(mapped) ? mapped : undefined
  }

  /**
   * Synchronous monotonic `tools.guard()` defense-in-depth check.
   * @param exec - pending tool execution.
   * @returns denial reason string when disallowed, or `undefined` when permitted.
   */
  checkToolGuard(exec: Readonly<ToolExecution>): string | undefined {
    const sessionId = exec.agent?.session?.id
    const resolved = this.resolveBinding(sessionId, Date.now())
    if (!resolved.ok) {
      if (resolved.unbound && !this.config.requireBinding) return undefined
      return resolved.message
    }
    return this.toolGuardReason(resolved.binding, exec)
  }

  private toolGuardReason(binding: PeerJobBinding, exec: Readonly<ToolExecution>): string | undefined {
    if (!this.toolAllowed(binding, exec.name)) return 'worker execution denied: tool is outside the job allow-list'
    const capability = this.resolveRequiredCapability(exec.name, binding)
    return capability !== undefined && this.admitted.get(exec) === capability
      ? undefined : 'worker execution denied: admission was not recorded for the required capability'
  }

  /** Recheck revocation at the scheduler's dispatch stage and abort cooperative tools at the wall deadline. */
  async handleDispatch(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
    const sessionId = exec.agent?.session.id
    const resolved = this.resolveBinding(sessionId, Date.now())
    if (!resolved.ok) {
      if (resolved.unbound && !this.config.requireBinding) return next()
      throw new HarnessError(resolved.message, 'JOB_TOOL_REFUSED')
    }
    const reason = this.toolGuardReason(resolved.binding, exec)
    if (reason !== undefined) throw new HarnessError(reason, 'JOB_TOOL_REFUSED')
    const original = exec.signal
    exec.signal = AbortSignal.any([original, AbortSignal.timeout(Math.min(2_147_483_647, resolved.remainingWallMs))])
    try {
      return await next()
    } finally {
      exec.signal = original
    }
  }

  /**
   * Fail-closed `tools/pre-execute` waterfall handler.
   * @param exec - pending tool execution.
   * @param next - downstream pre-execute chain.
   * @returns final pre-tool decision (`ask` is converted to `deny`).
   */
  async handlePreExecute(
    exec: ToolExecution,
    next: () => Promise<PreToolDecision>,
  ): Promise<PreToolDecision> {
    const now = Date.now()
    const session = exec.agent?.session
    const sessionId = session?.id
    const sessionKey = sessionId ?? '_unbound'
    const aHash = hashArguments(exec.arguments)
    const callId = String(exec.callId)

    const auditDeny = async (
      jobId: string,
      fence: string | number,
      reasonCode: string,
      reason: string,
    ): Promise<PreToolDecision> => {
      try {
        await this.enqueueAudit(sessionKey, {
          t: now,
          jobId,
          fence,
          toolName: exec.name,
          callId,
          argsHash: aHash,
          decision: 'deny',
          reasonCode,
        })
      } catch {
        // Denial stands even if the audit write also fails.
      }
      return { kind: 'deny', reason }
    }

    const resolved = this.resolveBinding(sessionId, now)
    if (!resolved.ok) {
      if (resolved.unbound && !this.config.requireBinding) {
        return next()
      }
      return auditDeny(resolved.jobId, resolved.fence, resolved.reasonCode, resolved.message)
    }

    const { binding, state, remainingWallMs } = resolved
    if (!this.toolAllowed(binding, exec.name)) {
      return auditDeny(
        binding.jobId,
        binding.fence,
        'TOOL_NOT_ALLOWED',
        'worker execution denied: tool is not in the job allow-list',
      )
    }

    const capability = this.resolveRequiredCapability(exec.name, binding)
    if (capability === undefined) {
      return auditDeny(
        binding.jobId,
        binding.fence,
        'CAPABILITY_MISSING',
        'worker execution denied: required capability is missing',
      )
    }

    // Atomically reserve a tool-call slot synchronously BEFORE any await.
    const maxToolCalls = effectiveLimit(binding.limits.maxToolCalls, this.config.maxToolCalls)
    if (state.toolCallsUsed >= maxToolCalls) {
      return auditDeny(
        binding.jobId,
        binding.fence,
        'TOOL_CALL_LIMIT_EXCEEDED',
        'worker execution denied: job tool-call budget exceeded',
      )
    }
    state.toolCallsUsed += 1

    let downstream: PreToolDecision
    try {
      downstream = await next()
    } catch {
      return auditDeny(binding.jobId, binding.fence, 'POLICY_FAILED', 'worker execution denied: downstream policy failed')
    }
    if (downstream.kind !== 'allow') {
      return auditDeny(binding.jobId, binding.fence, `POLICY_${downstream.kind.toUpperCase()}`, 'worker execution denied by downstream policy')
    }
    const current = this.resolveBinding(sessionId, Date.now())
    if (!current.ok) return auditDeny(current.jobId, current.fence, current.reasonCode, current.message)
    if (exec.signal.aborted || !this.toolAllowed(current.binding, exec.name)
      || this.resolveRequiredCapability(exec.name, current.binding) !== capability) {
      return auditDeny(binding.jobId, binding.fence, 'ADMISSION_CHANGED', 'worker execution denied: authorization changed')
    }

    let reasonCode = 'ADMITTED'
    if (this.config.admissionUrl !== undefined) {
      const admission = await this.callHubAdmission(
        this.config.admissionUrl,
        Math.min(remainingWallMs, current.remainingWallMs),
        binding.sessionId,
        current.binding.credentialRef !== undefined,
        {
          jobId: binding.jobId,
          fence: binding.fence,
          capability,
          toolName: exec.name,
          callId,
          argsHash: aHash,
          ...(this.config.admissionIncludeArgs ? { arguments: exec.arguments } : {}),
        },
        exec.signal,
      )
      if (!admission.allowed) {
        return auditDeny(
          binding.jobId,
          binding.fence,
          admission.reasonCode,
          admission.reason,
        )
      }
      reasonCode = 'HUB_ADMITTED'
    }

    try {
      await this.enqueueAudit(sessionKey, {
        t: Date.now(),
        jobId: binding.jobId,
        fence: binding.fence,
        toolName: exec.name,
        callId,
        argsHash: aHash,
        decision: 'allow',
        reasonCode,
      })
    } catch {
      return { kind: 'deny', reason: 'worker execution denied: durable audit write failed' }
    }

    this.admitted.set(exec, capability)
    return { kind: 'allow' }
  }

  private async callHubAdmission(
    url: string,
    remainingWallMs: number,
    sessionId: SessionId,
    requiresCredential: boolean,
    payload: Record<string, unknown>,
    callerSignal: AbortSignal,
  ): Promise<{ allowed: true } | { allowed: false; reasonCode: string; reason: string }> {
    const timeoutMs = Math.max(1, Math.min(this.config.admissionTimeoutMs, remainingWallMs))
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const signal = AbortSignal.any([callerSignal, timeoutSignal])
    try {
      signal.throwIfAborted()
      const provider = this.ctx.get('mcpHeaderProvider') as McpHeaderProviderService | undefined
      const dynamic = provider === undefined ? undefined : await beforeAbort(provider.headersFor(sessionId, this.config.admissionServerId), signal)
      const headers = new Headers(dynamic)
      if (requiresCredential && !headers.get('authorization')) throw new Error('missing admission authorization')
      headers.set('content-type', 'application/json')
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal,
        redirect: 'error',
      })
      if (!response.ok) {
        await response.body?.cancel()
        return {
          allowed: false,
          reasonCode: `HUB_HTTP_${String(response.status)}`,
          reason: 'worker execution denied: hub admission refused or failed',
        }
      }
      const parsed: unknown = await readAdmissionReply(response)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return {
          allowed: false,
          reasonCode: 'HUB_MALFORMED',
          reason: 'worker execution denied: hub admission returned malformed response',
        }
      }
      const record = parsed as Record<string, unknown>
      signal.throwIfAborted()
      if (record.allowed === true) {
        return { allowed: true }
      }
      return {
        allowed: false,
        reasonCode: record.allowed === false ? 'HUB_DENIED' : 'HUB_MALFORMED',
        reason: 'worker execution denied: hub admission denied the call',
      }
    } catch {
      return {
        allowed: false,
        reasonCode: timeoutSignal.aborted ? 'HUB_TIMEOUT' : 'HUB_UNAVAILABLE',
        reason: 'worker execution denied: hub admission unavailable',
      }
    }
  }

  /**
   * Enforce `maxSteps`, wall-clock deadlines, and `requirePinnedRoute` before
   * each model step in `agent/pre-step`.
   * @param payload - pre-step event payload.
   * @param next - downstream pre-step chain.
   * @returns `reject` on budget/policy violation, or delegates to `next()`.
   */
  async handlePreStep(
    payload: { agent: Agent; turn: number; step: number; signal: AbortSignal },
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> {
    const now = Date.now()
    const session = payload.agent.session
    const sessionId = session.id

    const rejectWithStop = async (
      jobId: string,
      fence: string | number,
      reasonCode: string,
    ): Promise<PreStepDecision> => {
      try {
        await this.enqueueAudit(sessionId, {
          t: now,
          turn: payload.turn,
          step: payload.step,
          jobId,
          fence,
          decision: 'deny',
          reasonCode,
        })
      } catch {
        // Still reject the step even if audit storage fails.
      }
      if (reasonCode === 'MAX_STEPS_EXCEEDED' || reasonCode === 'WALL_DEADLINE_EXCEEDED' || reasonCode === 'JOB_EXPIRED') {
        payload.agent.cancel({ kind: 'hook', reason: 'peer/budget' }, { keepInbox: true })
      }
      return { kind: 'reject' }
    }

    const resolved = this.resolveBinding(sessionId, now)
    if (!resolved.ok) {
      if (resolved.unbound && !this.config.requireBinding) {
        return next()
      }
      return rejectWithStop(resolved.jobId, resolved.fence, resolved.reasonCode)
    }

    const { binding, state } = resolved
    if (this.config.requirePinnedRoute) {
      const projections = this.ctx.get('sessionProjections') as SessionProjectionsLike | undefined
      const selected = projections?.snapshot(session, ['modelSelection']).values.modelSelection?.next
      const effective = selected ?? session.requestHeader()?.config ?? payload.agent.options
      if (!effective.provider || !effective.model || ('chain' in effective && effective.chain !== undefined)) {
        return rejectWithStop(binding.jobId, binding.fence, 'PINNED_ROUTE_REQUIRED')
      }
    }

    const maxSteps = effectiveLimit(binding.limits.maxSteps, this.config.maxSteps)
    if (state.stepsUsed >= maxSteps) {
      return rejectWithStop(binding.jobId, binding.fence, 'MAX_STEPS_EXCEEDED')
    }
    state.stepsUsed += 1
    return next()
  }

  /**
   * Preventive token-budget and pinned-route gate around `llm/stream`.
   * @param options - assembled LLM stream request.
   * @param next - downstream adapter stream factory.
   * @returns guarded chunk stream, or throws `LlmError` with `JOB_BUDGET_REFUSED`.
   */
  handleLlmStream(
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    const prepare = () => this.prepareLlmStream(options)
    if (prepare() === undefined) return next()
    return reserveWhileStreaming(prepare, next)
  }

  private prepareLlmStream(options: GenerateOptions): { state: SessionGuardState; reservation: number } | undefined {
    const sessionId = options.sessionId
    const resolved = this.resolveBinding(sessionId, Date.now())
    if (!resolved.ok) {
      if (resolved.unbound && !this.config.requireBinding) {
        return undefined
      }
      throw new LlmError(resolved.message, JOB_BUDGET_REFUSED_CODE)
    }

    const { binding, state } = resolved
    if (this.config.requirePinnedRoute) {
      if (options.chain !== undefined || !options.provider || !options.model) {
        throw new LlmError(
          'worker LLM dispatch refused: a single pinned provider/model route without a chain is required',
          JOB_BUDGET_REFUSED_CODE,
        )
      }
    }

    const meter = this.ctx.get('tokenMeter') as TokenMeterLike | undefined
    const projections = this.ctx.get('sessionProjections') as SessionProjectionsLike | undefined
    const sessions = this.ctx.get('sessions') as SessionsLookupLike | undefined
    if (meter === undefined || typeof meter.estimateMessage !== 'function'
      || projections === undefined || typeof projections.snapshot !== 'function'
      || sessions === undefined || typeof sessions.get !== 'function') {
      throw new LlmError('worker LLM dispatch refused: token metering service unavailable', JOB_BUDGET_REFUSED_CODE)
    }

    const session = sessions.get(sessionId as SessionId)
    if (session === undefined) {
      throw new LlmError('worker LLM dispatch refused: session unavailable for token metering', JOB_BUDGET_REFUSED_CODE)
    }

    const usage = projections.snapshot(session, ['tokenUsage']).values.tokenUsage
    if (usage === undefined) {
      throw new LlmError('worker LLM dispatch refused: tokenUsage projection unavailable', JOB_BUDGET_REFUSED_CODE)
    }

    const meteredTotal = usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
    if (!Number.isSafeInteger(meteredTotal) || meteredTotal < 0) {
      throw new LlmError('worker LLM dispatch refused: invalid metered token usage', JOB_BUDGET_REFUSED_CODE)
    }
    if (meteredTotal > state.highWaterMeteredTokens) {
      state.highWaterMeteredTokens = meteredTotal
    }

    const estimatedInput = estimateRequestInputTokens(meter, options)
    const reservedOutput = options.maxTokens
    if (reservedOutput === undefined || !Number.isSafeInteger(reservedOutput) || reservedOutput < 1) {
      throw new LlmError('worker LLM dispatch refused: a positive maxTokens is required', JOB_BUDGET_REFUSED_CODE)
    }
    const reservation = estimatedInput + reservedOutput
    const maxTotalTokens = effectiveLimit(binding.limits.maxTotalTokens, this.config.maxTotalTokens)
    const projectedTotal = state.highWaterMeteredTokens + state.inFlightReservedTokens + reservation
    if (!Number.isSafeInteger(projectedTotal) || projectedTotal > maxTotalTokens) {
      throw new LlmError(
        `worker LLM dispatch refused: projected token spend (${String(projectedTotal)}) exceeds job ceiling (${String(maxTotalTokens)})`,
        JOB_BUDGET_REFUSED_CODE,
      )
    }

    return { state, reservation }
  }

  /**
   * Compute the live effective profile identity for `sessionId` from the real
   * tool registry view and non-secret guard/binding configuration.
   * @param sessionId - target session id.
   * @returns identity description, or `undefined` when the session is unknown.
   */
  describeProfileIdentity(sessionId: SessionId): PeerProfileIdentityDescription | undefined {
    const agents = this.ctx.get('agents') as AgentsLookupLike | undefined
    const sessions = this.ctx.get('sessions') as SessionsLookupLike | undefined
    const bindings = this.ctx.get('peerJobBindings') as PeerJobBindingsService | undefined

    const agent = agents?.get?.(sessionId)
    const session = agent?.session ?? sessions?.get?.(sessionId)
    const binding = bindings?.get?.(sessionId)
    if (session === undefined) {
      return undefined
    }

    const toolsService = this.ctx.get('tools') as { schemas(scope?: Agent): ToolSchema[] } | undefined
    if (toolsService === undefined) return undefined
    const rawSchemas = toolsService.schemas(agent)
    const sortedSchemas = [...rawSchemas]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map(schema => ({
        name: schema.name,
        description: schema.description,
        parameters: schema.parameters,
        ...(schema.deferLoading === true ? { deferLoading: true } : {}),
      }))
    const toolNames = sortedSchemas.map(s => s.name)
    const presetId = session?.header?.agentPreset ?? this.config.presetId
    const mcpAllowlist = binding?.allowedToolNames === undefined
      ? null
      : [...binding.allowedToolNames].sort()

    const hash = sha256Hex(canonicalJson({
      presetId,
      harnessVersion: this.config.harnessVersion,
      tools: sortedSchemas,
      configDigest: this.configDigest,
      mcp: {
        endpointId: binding?.mcpEndpointId ?? null,
        allowlist: mcpAllowlist,
      },
    }))

    return {
      hash,
      presetId,
      toolNames,
      configDigest: this.configDigest,
    }
  }
}

function effectiveLimit(bindingLimit: number | undefined, configLimit: number): number {
  if (bindingLimit === undefined) return configLimit
  return Number.isSafeInteger(bindingLimit) && bindingLimit >= 0 ? Math.min(bindingLimit, configLimit) : 0
}

async function beforeAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const stopped = Promise.withResolvers<never>()
  const abort = (): void => stopped.reject(new Error('admission deadline reached'))
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  try {
    return await Promise.race([work, stopped.promise])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

async function readAdmissionReply(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (reader === undefined) return undefined
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const row = await reader.read()
      if (row.done) break
      bytes += row.value.byteLength
      if (bytes > 4096) {
        await reader.cancel()
        return undefined
      }
      chunks.push(row.value)
    }
    const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return decoded
  } finally {
    reader.releaseLock()
  }
}

function sanitizeUrlForDigest(rawUrl: string | undefined): string | null {
  if (rawUrl === undefined) return null
  const parsed = new URL(rawUrl)
  return `${parsed.origin}${parsed.pathname}`
}

function estimateRequestInputTokens(meter: TokenMeterLike, options: GenerateOptions): number {
  let total = 0
  for (const msg of options.messages) {
    // Only durable Message variants are passed by the loop; one-shot RequestUserInput
    // shares the same role/content fields structurally.
    total += meter.estimateMessage(msg as Message)
  }
  if (options.system !== undefined && options.system.length > 0) {
    total += Math.ceil(options.system.length / 4) + 4
  }
  if (options.tools !== undefined && options.tools.length > 0) {
    total += Math.ceil(JSON.stringify(options.tools).length / 4) + 4
  }
  return total
}

async function* reserveWhileStreaming(
  prepare: () => { state: SessionGuardState; reservation: number } | undefined,
  next: () => AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  const prepared = prepare()
  if (prepared === undefined) throw new LlmError('worker LLM dispatch refused: job binding disappeared', JOB_BUDGET_REFUSED_CODE)
  const { state, reservation } = prepared
  state.inFlightReservedTokens += reservation
  let usage: TokenUsage | undefined
  try {
    for await (const chunk of next()) {
      if (chunk.type === 'usage') usage = chunk.usage
      yield chunk
    }
  } finally {
    state.inFlightReservedTokens -= reservation
    const tokens = usage === undefined ? reservation : Math.max(
      usage.totalTokens ?? 0,
      usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
    )
    state.highWaterMeteredTokens += Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : reservation
  }
}
