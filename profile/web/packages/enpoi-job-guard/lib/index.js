// src/index.ts
import { isAbsolute, join as join2 } from "node:path";
import Schema from "@deepseek-ai/schemastery";
import { getDshRuntimeVersion } from "@deepseek-ai/dsh-app-boot";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

// src/guard.ts
import { HarnessError, LlmError } from "@deepseek-ai/dsh-llm";

// src/audit.ts
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value;
    return `{${Object.keys(record).sort().flatMap((key) => {
      const entry = record[key];
      return entry === void 0 ? [] : [`${JSON.stringify(key)}:${canonicalJson(entry)}`];
    }).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
function hashArguments(args) {
  return sha256Hex(canonicalJson(args));
}
function encodeAuditSegment(raw) {
  if (raw.length === 0) return "~empty";
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch;
    } else {
      out += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
    }
  }
  return out;
}
async function ensurePrivateAuditDir(dir) {
  const resolved = resolve(dir);
  try {
    const info = await lstat(resolved);
    if (!info.isDirectory() || (info.mode & 511) !== 448) {
      throw new Error("audit directory is not a regular directory");
    }
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(resolved, { recursive: true, mode: 448 });
  const created = await lstat(resolved);
  if (!created.isDirectory() || (created.mode & 511) !== 448) {
    throw new Error("audit directory could not be verified");
  }
}
async function appendBoundedPrivateFile(auditDir, sessionKey, record, maxBytes) {
  await ensurePrivateAuditDir(auditDir);
  const filePath = join(resolve(auditDir), `${encodeAuditSegment(sessionKey)}.jsonl`);
  try {
    const existing = await lstat(filePath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error("audit file path is not a regular file");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const line = `${JSON.stringify(record)}
`;
  const lineBytes = Buffer.byteLength(line, "utf8");
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(filePath, flags, 384);
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error("audit handle is not a regular file");
    }
    if ((info.mode & 511) !== 384 || info.nlink !== 1) throw new Error("audit file is not private");
    if (info.size + lineBytes > maxBytes) {
      throw new Error("session audit file byte limit exceeded");
    }
    await handle.writeFile(line, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function writeDurableAudit(options, record) {
  await appendBoundedPrivateFile(options.auditDir, options.sessionKey, record, options.auditMaxBytes);
}

// src/guard.ts
var JOB_BUDGET_REFUSED_CODE = "JOB_BUDGET_REFUSED";
var JobGuardRuntime = class {
  /**
   * @param ctx - Cordis plugin context.
   * @param config - validated, resolved guard configuration.
   */
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.configDigest = sha256Hex(canonicalJson({
      requireBinding: config.requireBinding,
      requirePinnedRoute: config.requirePinnedRoute,
      allowedTools: config.allowedTools === void 0 ? null : [...config.allowedTools].sort(),
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
      instanceId: config.instanceId
    }));
  }
  sessionStates = /* @__PURE__ */ new Map();
  configDigest;
  auditChains = /* @__PURE__ */ new Map();
  admitted = /* @__PURE__ */ new WeakMap();
  /**
   * Clear tracked session state when a session is disposed.
   * @param sessionId - disposed session id.
   */
  forgetSession(sessionId) {
    this.sessionStates.delete(sessionId);
    this.auditChains.delete(sessionId);
  }
  /**
   * Clear all in-memory state on plugin disposal.
   */
  dispose() {
    this.sessionStates.clear();
    this.auditChains.clear();
  }
  /**
   * Serialize per-session audit writes so concurrent batches never race size
   * checks or append ordering on the `0600` file.
   */
  enqueueAudit(sessionKey, record) {
    const prior = this.auditChains.get(sessionKey) ?? Promise.resolve();
    const next = prior.then(
      () => writeDurableAudit({
        auditDir: this.config.auditDir,
        auditMaxBytes: this.config.auditMaxBytes,
        sessionKey
      }, record)
    );
    this.auditChains.set(sessionKey, next.catch(() => void 0));
    return next;
  }
  resolveBinding(sessionId, now) {
    if (sessionId === void 0 || sessionId.length === 0) {
      return {
        ok: false,
        unbound: !this.sessionStates.has(sessionId ?? ""),
        reasonCode: "BINDING_MISSING",
        message: "worker execution denied: no bound session id",
        jobId: "unbound",
        fence: "none"
      };
    }
    const bindings = this.ctx.get("peerJobBindings");
    if (bindings === void 0 || typeof bindings.get !== "function") {
      return {
        ok: false,
        unbound: !this.sessionStates.has(sessionId),
        reasonCode: "BINDING_SERVICE_MISSING",
        message: "worker execution denied: job bindings service is unavailable",
        jobId: "unbound",
        fence: "none"
      };
    }
    const binding = bindings.get(sessionId);
    if (binding === void 0) {
      return {
        ok: false,
        unbound: !this.sessionStates.has(sessionId),
        reasonCode: "BINDING_MISSING",
        message: "worker execution denied: session has no active job binding",
        jobId: "unbound",
        fence: "none"
      };
    }
    const jobId = typeof binding.jobId === "string" && binding.jobId.length > 0 ? binding.jobId : "invalid";
    const fence = (typeof binding.fence === "string" ? binding.fence.length > 0 : Number.isSafeInteger(binding.fence) && binding.fence > 0) ? binding.fence : "invalid";
    if (binding.revoked === true || binding.revokedAt !== void 0) {
      return {
        ok: false,
        unbound: false,
        reasonCode: "JOB_REVOKED",
        message: "worker execution denied: job binding has been revoked",
        jobId,
        fence
      };
    }
    if (binding.sessionId !== sessionId || jobId === "invalid" || fence === "invalid" || !Number.isFinite(binding.expiresAt) || !Number.isFinite(binding.createdAt) || !Array.isArray(binding.capabilities)) {
      return {
        ok: false,
        unbound: false,
        reasonCode: "BINDING_INVALID",
        message: "worker execution denied: malformed job binding",
        jobId,
        fence
      };
    }
    if (this.config.expectedFence !== void 0 && binding.fence !== this.config.expectedFence) {
      return {
        ok: false,
        unbound: false,
        reasonCode: "FENCE_MISMATCH",
        message: "worker execution denied: job fence mismatch",
        jobId,
        fence
      };
    }
    if (this.config.instanceId !== void 0 && binding.instanceId !== this.config.instanceId) {
      return {
        ok: false,
        unbound: false,
        reasonCode: "INSTANCE_MISMATCH",
        message: "worker execution denied: worker instance mismatch",
        jobId,
        fence
      };
    }
    if (now >= binding.expiresAt) {
      return {
        ok: false,
        unbound: false,
        reasonCode: "JOB_EXPIRED",
        message: "worker execution denied: job binding expired",
        jobId,
        fence
      };
    }
    const maxWallMs = effectiveLimit(binding.limits.maxWallMs, this.config.maxWallMs);
    const wallDeadline = Math.min(binding.expiresAt, binding.createdAt + maxWallMs);
    if (now >= wallDeadline) {
      return {
        ok: false,
        unbound: false,
        reasonCode: "WALL_DEADLINE_EXCEEDED",
        message: "worker execution denied: job wall-clock deadline exceeded",
        jobId,
        fence
      };
    }
    let state = this.sessionStates.get(sessionId);
    if (state === void 0) {
      state = {
        jobId: binding.jobId,
        fence: canonicalJson(binding.fence),
        instanceId: binding.instanceId,
        toolCallsUsed: 0,
        stepsUsed: 0,
        inFlightReservedTokens: 0,
        highWaterMeteredTokens: 0
      };
      this.sessionStates.set(sessionId, state);
    } else if (state.jobId !== binding.jobId || state.fence !== canonicalJson(binding.fence) || state.instanceId !== binding.instanceId) {
      return {
        ok: false,
        unbound: false,
        reasonCode: "FENCE_MISMATCH",
        message: "worker execution denied: session job or fence changed",
        jobId: binding.jobId,
        fence: binding.fence
      };
    }
    return { ok: true, binding, state, remainingWallMs: wallDeadline - now };
  }
  toolAllowed(binding, name2) {
    return (this.config.allowedTools?.includes(name2) ?? false) && (binding.allowedToolNames?.includes(name2) ?? false);
  }
  resolveRequiredCapability(toolName, binding) {
    const mapped = this.config.toolCapabilities[toolName] ?? this.config.defaultCapability ?? toolName;
    return binding.capabilities.includes(mapped) ? mapped : void 0;
  }
  /**
   * Synchronous monotonic `tools.guard()` defense-in-depth check.
   * @param exec - pending tool execution.
   * @returns denial reason string when disallowed, or `undefined` when permitted.
   */
  checkToolGuard(exec) {
    const sessionId = exec.agent?.session?.id;
    const resolved = this.resolveBinding(sessionId, Date.now());
    if (!resolved.ok) {
      if (resolved.unbound && !this.config.requireBinding) return void 0;
      return resolved.message;
    }
    return this.toolGuardReason(resolved.binding, exec);
  }
  toolGuardReason(binding, exec) {
    if (!this.toolAllowed(binding, exec.name)) return "worker execution denied: tool is outside the job allow-list";
    const capability = this.resolveRequiredCapability(exec.name, binding);
    return capability !== void 0 && this.admitted.get(exec) === capability ? void 0 : "worker execution denied: admission was not recorded for the required capability";
  }
  /** Recheck revocation at the scheduler's dispatch stage and abort cooperative tools at the wall deadline. */
  async handleDispatch(exec, next) {
    const sessionId = exec.agent?.session.id;
    const resolved = this.resolveBinding(sessionId, Date.now());
    if (!resolved.ok) {
      if (resolved.unbound && !this.config.requireBinding) return next();
      throw new HarnessError(resolved.message, "JOB_TOOL_REFUSED");
    }
    const reason = this.toolGuardReason(resolved.binding, exec);
    if (reason !== void 0) throw new HarnessError(reason, "JOB_TOOL_REFUSED");
    const original = exec.signal;
    exec.signal = AbortSignal.any([original, AbortSignal.timeout(Math.min(2147483647, resolved.remainingWallMs))]);
    try {
      return await next();
    } finally {
      exec.signal = original;
    }
  }
  /**
   * Fail-closed `tools/pre-execute` waterfall handler.
   * @param exec - pending tool execution.
   * @param next - downstream pre-execute chain.
   * @returns final pre-tool decision (`ask` is converted to `deny`).
   */
  async handlePreExecute(exec, next) {
    const now = Date.now();
    const session = exec.agent?.session;
    const sessionId = session?.id;
    const sessionKey = sessionId ?? "_unbound";
    const aHash = hashArguments(exec.arguments);
    const callId = String(exec.callId);
    const auditDeny = async (jobId, fence, reasonCode2, reason) => {
      try {
        await this.enqueueAudit(sessionKey, {
          t: now,
          jobId,
          fence,
          toolName: exec.name,
          callId,
          argsHash: aHash,
          decision: "deny",
          reasonCode: reasonCode2
        });
      } catch {
      }
      return { kind: "deny", reason };
    };
    const resolved = this.resolveBinding(sessionId, now);
    if (!resolved.ok) {
      if (resolved.unbound && !this.config.requireBinding) {
        return next();
      }
      return auditDeny(resolved.jobId, resolved.fence, resolved.reasonCode, resolved.message);
    }
    const { binding, state, remainingWallMs } = resolved;
    if (!this.toolAllowed(binding, exec.name)) {
      return auditDeny(
        binding.jobId,
        binding.fence,
        "TOOL_NOT_ALLOWED",
        "worker execution denied: tool is not in the job allow-list"
      );
    }
    const capability = this.resolveRequiredCapability(exec.name, binding);
    if (capability === void 0) {
      return auditDeny(
        binding.jobId,
        binding.fence,
        "CAPABILITY_MISSING",
        "worker execution denied: required capability is missing"
      );
    }
    const maxToolCalls = effectiveLimit(binding.limits.maxToolCalls, this.config.maxToolCalls);
    if (state.toolCallsUsed >= maxToolCalls) {
      return auditDeny(
        binding.jobId,
        binding.fence,
        "TOOL_CALL_LIMIT_EXCEEDED",
        "worker execution denied: job tool-call budget exceeded"
      );
    }
    state.toolCallsUsed += 1;
    let downstream;
    try {
      downstream = await next();
    } catch {
      return auditDeny(binding.jobId, binding.fence, "POLICY_FAILED", "worker execution denied: downstream policy failed");
    }
    if (downstream.kind !== "allow") {
      return auditDeny(binding.jobId, binding.fence, `POLICY_${downstream.kind.toUpperCase()}`, "worker execution denied by downstream policy");
    }
    const current = this.resolveBinding(sessionId, Date.now());
    if (!current.ok) return auditDeny(current.jobId, current.fence, current.reasonCode, current.message);
    if (exec.signal.aborted || !this.toolAllowed(current.binding, exec.name) || this.resolveRequiredCapability(exec.name, current.binding) !== capability) {
      return auditDeny(binding.jobId, binding.fence, "ADMISSION_CHANGED", "worker execution denied: authorization changed");
    }
    let reasonCode = "ADMITTED";
    if (this.config.admissionUrl !== void 0) {
      const admission = await this.callHubAdmission(
        this.config.admissionUrl,
        Math.min(remainingWallMs, current.remainingWallMs),
        binding.sessionId,
        current.binding.credentialRef !== void 0,
        {
          jobId: binding.jobId,
          fence: binding.fence,
          capability,
          toolName: exec.name,
          callId,
          argsHash: aHash,
          ...this.config.admissionIncludeArgs ? { arguments: exec.arguments } : {}
        },
        exec.signal
      );
      if (!admission.allowed) {
        return auditDeny(
          binding.jobId,
          binding.fence,
          admission.reasonCode,
          admission.reason
        );
      }
      reasonCode = "HUB_ADMITTED";
    }
    try {
      await this.enqueueAudit(sessionKey, {
        t: Date.now(),
        jobId: binding.jobId,
        fence: binding.fence,
        toolName: exec.name,
        callId,
        argsHash: aHash,
        decision: "allow",
        reasonCode
      });
    } catch {
      return { kind: "deny", reason: "worker execution denied: durable audit write failed" };
    }
    this.admitted.set(exec, capability);
    return { kind: "allow" };
  }
  async callHubAdmission(url, remainingWallMs, sessionId, requiresCredential, payload, callerSignal) {
    const timeoutMs = Math.max(1, Math.min(this.config.admissionTimeoutMs, remainingWallMs));
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([callerSignal, timeoutSignal]);
    try {
      signal.throwIfAborted();
      const provider = this.ctx.get("mcpHeaderProvider");
      const dynamic = provider === void 0 ? void 0 : await beforeAbort(provider.headersFor(sessionId, this.config.admissionServerId), signal);
      const headers = new Headers(dynamic);
      if (requiresCredential && !headers.get("authorization")) throw new Error("missing admission authorization");
      headers.set("content-type", "application/json");
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal,
        redirect: "error"
      });
      if (!response.ok) {
        await response.body?.cancel();
        return {
          allowed: false,
          reasonCode: `HUB_HTTP_${String(response.status)}`,
          reason: "worker execution denied: hub admission refused or failed"
        };
      }
      const parsed = await readAdmissionReply(response);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {
          allowed: false,
          reasonCode: "HUB_MALFORMED",
          reason: "worker execution denied: hub admission returned malformed response"
        };
      }
      const record = parsed;
      signal.throwIfAborted();
      if (record.allowed === true) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reasonCode: record.allowed === false ? "HUB_DENIED" : "HUB_MALFORMED",
        reason: "worker execution denied: hub admission denied the call"
      };
    } catch {
      return {
        allowed: false,
        reasonCode: timeoutSignal.aborted ? "HUB_TIMEOUT" : "HUB_UNAVAILABLE",
        reason: "worker execution denied: hub admission unavailable"
      };
    }
  }
  /**
   * Enforce `maxSteps`, wall-clock deadlines, and `requirePinnedRoute` before
   * each model step in `agent/pre-step`.
   * @param payload - pre-step event payload.
   * @param next - downstream pre-step chain.
   * @returns `reject` on budget/policy violation, or delegates to `next()`.
   */
  async handlePreStep(payload, next) {
    const now = Date.now();
    const session = payload.agent.session;
    const sessionId = session.id;
    const rejectWithStop = async (jobId, fence, reasonCode) => {
      try {
        await this.enqueueAudit(sessionId, {
          t: now,
          turn: payload.turn,
          step: payload.step,
          jobId,
          fence,
          decision: "deny",
          reasonCode
        });
      } catch {
      }
      if (reasonCode === "MAX_STEPS_EXCEEDED" || reasonCode === "WALL_DEADLINE_EXCEEDED" || reasonCode === "JOB_EXPIRED") {
        payload.agent.cancel({ kind: "hook", reason: "peer/budget" }, { keepInbox: true });
      }
      return { kind: "reject" };
    };
    const resolved = this.resolveBinding(sessionId, now);
    if (!resolved.ok) {
      if (resolved.unbound && !this.config.requireBinding) {
        return next();
      }
      return rejectWithStop(resolved.jobId, resolved.fence, resolved.reasonCode);
    }
    const { binding, state } = resolved;
    if (this.config.requirePinnedRoute) {
      const projections = this.ctx.get("sessionProjections");
      const selected = projections?.snapshot(session, ["modelSelection"]).values.modelSelection?.next;
      const effective = selected ?? session.requestHeader()?.config ?? payload.agent.options;
      if (!effective.provider || !effective.model || "chain" in effective && effective.chain !== void 0) {
        return rejectWithStop(binding.jobId, binding.fence, "PINNED_ROUTE_REQUIRED");
      }
    }
    const maxSteps = effectiveLimit(binding.limits.maxSteps, this.config.maxSteps);
    if (state.stepsUsed >= maxSteps) {
      return rejectWithStop(binding.jobId, binding.fence, "MAX_STEPS_EXCEEDED");
    }
    state.stepsUsed += 1;
    return next();
  }
  /**
   * Preventive token-budget and pinned-route gate around `llm/stream`.
   * @param options - assembled LLM stream request.
   * @param next - downstream adapter stream factory.
   * @returns guarded chunk stream, or throws `LlmError` with `JOB_BUDGET_REFUSED`.
   */
  handleLlmStream(options, next) {
    const prepare = () => this.prepareLlmStream(options);
    if (prepare() === void 0) return next();
    return reserveWhileStreaming(prepare, next);
  }
  prepareLlmStream(options) {
    const sessionId = options.sessionId;
    const resolved = this.resolveBinding(sessionId, Date.now());
    if (!resolved.ok) {
      if (resolved.unbound && !this.config.requireBinding) {
        return void 0;
      }
      throw new LlmError(resolved.message, JOB_BUDGET_REFUSED_CODE);
    }
    const { binding, state } = resolved;
    if (this.config.requirePinnedRoute) {
      if (options.chain !== void 0 || !options.provider || !options.model) {
        throw new LlmError(
          "worker LLM dispatch refused: a single pinned provider/model route without a chain is required",
          JOB_BUDGET_REFUSED_CODE
        );
      }
    }
    const meter = this.ctx.get("tokenMeter");
    const projections = this.ctx.get("sessionProjections");
    const sessions = this.ctx.get("sessions");
    if (meter === void 0 || typeof meter.estimateMessage !== "function" || projections === void 0 || typeof projections.snapshot !== "function" || sessions === void 0 || typeof sessions.get !== "function") {
      throw new LlmError("worker LLM dispatch refused: token metering service unavailable", JOB_BUDGET_REFUSED_CODE);
    }
    const session = sessions.get(sessionId);
    if (session === void 0) {
      throw new LlmError("worker LLM dispatch refused: session unavailable for token metering", JOB_BUDGET_REFUSED_CODE);
    }
    const usage = projections.snapshot(session, ["tokenUsage"]).values.tokenUsage;
    if (usage === void 0) {
      throw new LlmError("worker LLM dispatch refused: tokenUsage projection unavailable", JOB_BUDGET_REFUSED_CODE);
    }
    const meteredTotal = usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    if (!Number.isSafeInteger(meteredTotal) || meteredTotal < 0) {
      throw new LlmError("worker LLM dispatch refused: invalid metered token usage", JOB_BUDGET_REFUSED_CODE);
    }
    if (meteredTotal > state.highWaterMeteredTokens) {
      state.highWaterMeteredTokens = meteredTotal;
    }
    const estimatedInput = estimateRequestInputTokens(meter, options);
    const reservedOutput = options.maxTokens;
    if (reservedOutput === void 0 || !Number.isSafeInteger(reservedOutput) || reservedOutput < 1) {
      throw new LlmError("worker LLM dispatch refused: a positive maxTokens is required", JOB_BUDGET_REFUSED_CODE);
    }
    const reservation = estimatedInput + reservedOutput;
    const maxTotalTokens = effectiveLimit(binding.limits.maxTotalTokens, this.config.maxTotalTokens);
    const projectedTotal = state.highWaterMeteredTokens + state.inFlightReservedTokens + reservation;
    if (!Number.isSafeInteger(projectedTotal) || projectedTotal > maxTotalTokens) {
      throw new LlmError(
        `worker LLM dispatch refused: projected token spend (${String(projectedTotal)}) exceeds job ceiling (${String(maxTotalTokens)})`,
        JOB_BUDGET_REFUSED_CODE
      );
    }
    return { state, reservation };
  }
  /**
   * Compute the live effective profile identity for `sessionId` from the real
   * tool registry view and non-secret guard/binding configuration.
   * @param sessionId - target session id.
   * @returns identity description, or `undefined` when the session is unknown.
   */
  describeProfileIdentity(sessionId) {
    const agents = this.ctx.get("agents");
    const sessions = this.ctx.get("sessions");
    const bindings = this.ctx.get("peerJobBindings");
    const agent = agents?.get?.(sessionId);
    const session = agent?.session ?? sessions?.get?.(sessionId);
    const binding = bindings?.get?.(sessionId);
    if (session === void 0) {
      return void 0;
    }
    const toolsService = this.ctx.get("tools");
    if (toolsService === void 0) return void 0;
    const rawSchemas = toolsService.schemas(agent);
    const sortedSchemas = [...rawSchemas].sort((a, b) => a.name < b.name ? -1 : 1).map((schema) => ({
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
      ...schema.deferLoading === true ? { deferLoading: true } : {}
    }));
    const toolNames = sortedSchemas.map((s) => s.name);
    const presetId = session?.header?.agentPreset ?? this.config.presetId;
    const mcpAllowlist = binding?.allowedToolNames === void 0 ? null : [...binding.allowedToolNames].sort();
    const hash = sha256Hex(canonicalJson({
      presetId,
      harnessVersion: this.config.harnessVersion,
      tools: sortedSchemas,
      configDigest: this.configDigest,
      mcp: {
        endpointId: binding?.mcpEndpointId ?? null,
        allowlist: mcpAllowlist
      }
    }));
    return {
      hash,
      presetId,
      toolNames,
      configDigest: this.configDigest
    };
  }
};
function effectiveLimit(bindingLimit, configLimit) {
  if (bindingLimit === void 0) return configLimit;
  return Number.isSafeInteger(bindingLimit) && bindingLimit >= 0 ? Math.min(bindingLimit, configLimit) : 0;
}
async function beforeAbort(work, signal) {
  const stopped = Promise.withResolvers();
  const abort = () => stopped.reject(new Error("admission deadline reached"));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await Promise.race([work, stopped.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
async function readAdmissionReply(response) {
  const reader = response.body?.getReader();
  if (reader === void 0) return void 0;
  const chunks = [];
  let bytes = 0;
  try {
    for (; ; ) {
      const row = await reader.read();
      if (row.done) break;
      bytes += row.value.byteLength;
      if (bytes > 4096) {
        await reader.cancel();
        return void 0;
      }
      chunks.push(row.value);
    }
    const decoded = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return decoded;
  } finally {
    reader.releaseLock();
  }
}
function sanitizeUrlForDigest(rawUrl) {
  if (rawUrl === void 0) return null;
  const parsed = new URL(rawUrl);
  return `${parsed.origin}${parsed.pathname}`;
}
function estimateRequestInputTokens(meter, options) {
  let total = 0;
  for (const msg of options.messages) {
    total += meter.estimateMessage(msg);
  }
  if (options.system !== void 0 && options.system.length > 0) {
    total += Math.ceil(options.system.length / 4) + 4;
  }
  if (options.tools !== void 0 && options.tools.length > 0) {
    total += Math.ceil(JSON.stringify(options.tools).length / 4) + 4;
  }
  return total;
}
async function* reserveWhileStreaming(prepare, next) {
  const prepared = prepare();
  if (prepared === void 0) throw new LlmError("worker LLM dispatch refused: job binding disappeared", JOB_BUDGET_REFUSED_CODE);
  const { state, reservation } = prepared;
  state.inFlightReservedTokens += reservation;
  let usage;
  try {
    for await (const chunk of next()) {
      if (chunk.type === "usage") usage = chunk.usage;
      yield chunk;
    }
  } finally {
    state.inFlightReservedTokens -= reservation;
    const tokens = usage === void 0 ? reservation : Math.max(
      usage.totalTokens ?? 0,
      usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    );
    state.highWaterMeteredTokens += Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : reservation;
  }
}

// src/index.ts
var name = "enpoi-job-guard";
var inject = ["tools"];
var DEFAULT_MAX_STEPS = 32;
var DEFAULT_MAX_TOOL_CALLS = 64;
var DEFAULT_MAX_WALL_MS = 6e5;
var DEFAULT_MAX_TOTAL_TOKENS = 2e5;
var DEFAULT_MAX_TOKENS_RESERVE = 4096;
var DEFAULT_ADMISSION_TIMEOUT_MS = 5e3;
var DEFAULT_ADMISSION_SERVER_ID = "job-guard-admission";
var DEFAULT_AUDIT_MAX_BYTES = 1048576;
var MIN_AUDIT_MAX_BYTES = 128;
var Config = Schema.object({
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
  presetId: Schema.string().default("worker"),
  harnessVersion: Schema.string().min(1),
  expectedFence: Schema.union([Schema.string().min(1), Schema.natural().min(1)]),
  instanceId: Schema.string().min(1)
});
function assertPositiveInt(value, field, min = 1) {
  if (value === void 0 || !Number.isSafeInteger(value) || value < min) {
    throw new Error(`enpoi-job-guard: ${field} must be an integer >= ${String(min)}`);
  }
  return value;
}
function resolveJobGuardConfig(raw = {}) {
  const requireBinding = raw.requireBinding ?? true;
  if (typeof requireBinding !== "boolean") {
    throw new Error("enpoi-job-guard: requireBinding must be a boolean");
  }
  const requirePinnedRoute = raw.requirePinnedRoute ?? true;
  if (typeof requirePinnedRoute !== "boolean") {
    throw new Error("enpoi-job-guard: requirePinnedRoute must be a boolean");
  }
  let allowedTools;
  if (raw.allowedTools !== void 0) {
    if (!Array.isArray(raw.allowedTools)) {
      throw new Error("enpoi-job-guard: allowedTools must be an array of non-empty strings");
    }
    const seen = /* @__PURE__ */ new Set();
    for (const item of raw.allowedTools) {
      if (typeof item !== "string" || item.length === 0) {
        throw new Error("enpoi-job-guard: allowedTools entries must be non-empty strings");
      }
      if (seen.has(item)) {
        throw new Error(`enpoi-job-guard: allowedTools contains duplicate entry "${item}"`);
      }
      seen.add(item);
    }
    allowedTools = Object.freeze([...raw.allowedTools]);
  }
  const toolCapabilitiesRaw = raw.toolCapabilities ?? {};
  if (typeof toolCapabilitiesRaw !== "object" || toolCapabilitiesRaw === null || Array.isArray(toolCapabilitiesRaw)) {
    throw new Error("enpoi-job-guard: toolCapabilities must be a plain object");
  }
  const capabilityEntries = [];
  for (const [k, v] of Object.entries(toolCapabilitiesRaw)) {
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`enpoi-job-guard: toolCapabilities["${k}"] must be a non-empty string`);
    }
    capabilityEntries.push([k, v]);
  }
  if (raw.defaultCapability !== void 0 && (typeof raw.defaultCapability !== "string" || raw.defaultCapability.length === 0)) {
    throw new Error("enpoi-job-guard: defaultCapability must be a non-empty string");
  }
  let admissionUrl;
  if (raw.admissionUrl !== void 0) {
    if (typeof raw.admissionUrl !== "string" || raw.admissionUrl.length === 0) {
      throw new Error("enpoi-job-guard: admissionUrl must be a non-empty HTTP(S) URL");
    }
    let parsed;
    try {
      parsed = new URL(raw.admissionUrl);
    } catch {
      throw new Error("enpoi-job-guard: admissionUrl is not a valid URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`enpoi-job-guard: admissionUrl must use http: or https: (got ${parsed.protocol})`);
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("enpoi-job-guard: admissionUrl must not contain credentials, a query, or a fragment");
    }
    admissionUrl = parsed.toString();
  }
  const admissionIncludeArgs = raw.admissionIncludeArgs ?? false;
  if (typeof admissionIncludeArgs !== "boolean") {
    throw new Error("enpoi-job-guard: admissionIncludeArgs must be a boolean");
  }
  const admissionServerId = raw.admissionServerId ?? DEFAULT_ADMISSION_SERVER_ID;
  if (typeof admissionServerId !== "string" || admissionServerId.length === 0) {
    throw new Error("enpoi-job-guard: admissionServerId must be a non-empty string");
  }
  const auditDir = raw.auditDir ?? join2(resolveDshHome(), "enpoi-job-guard");
  if (!isAbsolute(auditDir)) {
    throw new Error("enpoi-job-guard: auditDir must be an absolute path");
  }
  const presetId = raw.presetId ?? "worker";
  if (typeof presetId !== "string") {
    throw new Error("enpoi-job-guard: presetId must be a string");
  }
  const harnessVersion = raw.harnessVersion ?? getDshRuntimeVersion();
  if (typeof harnessVersion !== "string" || harnessVersion.length === 0) {
    throw new Error("enpoi-job-guard: harnessVersion must be a non-empty string");
  }
  const admissionTimeoutMs = assertPositiveInt(raw.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS, "admissionTimeoutMs");
  if (admissionTimeoutMs > 2147483647) throw new Error("enpoi-job-guard: admissionTimeoutMs exceeds timer range");
  return Object.freeze({
    requireBinding,
    requirePinnedRoute,
    allowedTools,
    toolCapabilities: Object.freeze(Object.fromEntries(capabilityEntries)),
    defaultCapability: raw.defaultCapability,
    maxSteps: assertPositiveInt(raw.maxSteps ?? DEFAULT_MAX_STEPS, "maxSteps"),
    maxToolCalls: assertPositiveInt(raw.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS, "maxToolCalls"),
    maxWallMs: assertPositiveInt(raw.maxWallMs ?? DEFAULT_MAX_WALL_MS, "maxWallMs"),
    maxTotalTokens: assertPositiveInt(raw.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS, "maxTotalTokens"),
    defaultMaxTokensReserve: assertPositiveInt(raw.defaultMaxTokensReserve ?? DEFAULT_MAX_TOKENS_RESERVE, "defaultMaxTokensReserve"),
    admissionUrl,
    admissionTimeoutMs,
    admissionServerId,
    admissionIncludeArgs,
    auditDir,
    auditMaxBytes: assertPositiveInt(raw.auditMaxBytes ?? DEFAULT_AUDIT_MAX_BYTES, "auditMaxBytes", MIN_AUDIT_MAX_BYTES),
    presetId,
    harnessVersion,
    expectedFence: raw.expectedFence,
    instanceId: raw.instanceId
  });
}
function apply(ctx, config = {}) {
  const resolved = resolveJobGuardConfig(config);
  const runtime = new JobGuardRuntime(ctx, resolved);
  const identityService = {
    describe: (sessionId) => runtime.describeProfileIdentity(sessionId)
  };
  ctx.effect(() => {
    ctx.provide("peerProfileIdentity", identityService);
    const disposeGuard = ctx.tools.guard((exec) => runtime.checkToolGuard(exec));
    const disposePreExecute = ctx.on(
      "tools/pre-execute",
      (exec, next) => runtime.handlePreExecute(exec, next),
      { prepend: true }
    );
    const disposeDispatch = ctx.on("tools/execute", (exec, next) => runtime.handleDispatch(exec, next), { prepend: true });
    const disposePreStep = ctx.on(
      "agent/pre-step",
      (payload, next) => runtime.handlePreStep(payload, next),
      { prepend: true }
    );
    const disposeLlmStream = ctx.on(
      "llm/stream",
      (options, next) => runtime.handleLlmStream(options, next),
      { prepend: true }
    );
    const disposeRequest = ctx.on("agent/request", async ({ agent }, next) => {
      const request = await next();
      const bindings = ctx.get("peerJobBindings");
      if (!resolved.requireBinding && bindings?.get(agent.id) === void 0) return request;
      return request.maxTokens === void 0 ? { ...request, maxTokens: resolved.defaultMaxTokensReserve } : request;
    }, { prepend: true });
    const disposeSessionDisposed = ctx.on("session/disposed", (session) => {
      runtime.forgetSession(session.id);
    });
    return () => {
      disposeGuard();
      disposePreExecute();
      disposeDispatch();
      disposePreStep();
      disposeLlmStream();
      disposeRequest();
      disposeSessionDisposed();
      runtime.dispose();
    };
  }, "enpoi-job-guard.hooks");
  const registeredTools = ctx.tools.schemas().map((t) => t.name);
  if (resolved.allowedTools !== void 0) {
    const allowedSet = new Set(resolved.allowedTools);
    const extraTools = registeredTools.filter((toolName) => !allowedSet.has(toolName));
    if (extraTools.length > 0) {
      ctx.logger.warn(
        `enpoi-job-guard: ${String(extraTools.length)} registered tool(s) sit outside guard Config allowedTools and will be denied at execution: ${extraTools.join(", ")}`
      );
    }
  }
}
export {
  Config,
  DEFAULT_ADMISSION_SERVER_ID,
  DEFAULT_ADMISSION_TIMEOUT_MS,
  DEFAULT_AUDIT_MAX_BYTES,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_TOKENS_RESERVE,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_MAX_TOTAL_TOKENS,
  DEFAULT_MAX_WALL_MS,
  JOB_BUDGET_REFUSED_CODE,
  JobGuardRuntime,
  MIN_AUDIT_MAX_BYTES,
  apply,
  canonicalJson,
  encodeAuditSegment,
  hashArguments,
  inject,
  name,
  resolveJobGuardConfig,
  sha256Hex,
  writeDurableAudit
};
