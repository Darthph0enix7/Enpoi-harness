// src/fold.ts
var PREVIEW_CHARS = 240;
var BODY_SYSTEM_CHARS = 4e3;
var BODY_MESSAGE_CHARS = 600;
var BODY_MESSAGE_COUNT = 6;
var CAPS = Object.freeze({
  recentFailures: 5,
  recentTools: 10,
  injections: 15,
  subagents: 20,
  asks: 10,
  incidents: 10,
  snapshotMessages: 20,
  snapshotTools: 60
});
function clampRecentTools(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 10;
  return Math.min(Math.max(Math.trunc(numeric), 1), 50);
}
function preview(value, max = PREVIEW_CHARS) {
  if (typeof value !== "string" || value === "") return void 0;
  const text = value.replaceAll(/\s+/g, " ").trim();
  if (text === "") return void 0;
  return text.length <= max ? text : `${text.slice(0, max)}\u2026`;
}
function foldToolCall(call) {
  return {
    tool: call.tool,
    status: call.status,
    ...call.argumentPreview === void 0 ? {} : { argumentPreview: preview(call.argumentPreview) },
    ...call.resultPreview === void 0 ? {} : { resultPreview: preview(call.resultPreview) },
    ...call.error === void 0 ? {} : {
      error: {
        name: call.error.name,
        code: call.error.code,
        ...call.error.reason === void 0 ? {} : { reason: preview(call.error.reason) }
      }
    }
  };
}
function foldAsk(ask) {
  if (ask.kind === "approval") {
    return {
      kind: "approval",
      askId: ask.askId,
      toolName: ask.toolName,
      ...ask.callId === void 0 ? {} : { callId: ask.callId },
      ...ask.reason === void 0 ? {} : { reason: preview(ask.reason) },
      since: ask.since
    };
  }
  return {
    kind: "question",
    askId: ask.askId,
    since: ask.since,
    questions: ask.questions.slice(0, 5).map((question) => ({
      id: question.id,
      question: preview(question.question),
      ...question.header === void 0 ? {} : { header: preview(question.header, 80) },
      ...question.options === void 0 ? {} : { options: question.options.slice(0, 8).map((option) => ({ label: preview(option.label, 80) })) }
    }))
  };
}
function foldFailure(failure) {
  return {
    seq: failure.seq,
    provider: failure.provider,
    model: failure.model,
    code: failure.code,
    message: preview(failure.message, 200),
    ...failure.link === void 0 ? {} : { link: failure.link },
    ...failure.identity === void 0 ? {} : { identity: preview(failure.identity, 60) },
    ...failure.next === void 0 ? {} : { next: `${failure.next.provider}/${failure.next.model}` }
  };
}
function foldDigest(digest) {
  const state = digest.state;
  return {
    sessionId: digest.sessionId,
    latch: state.latch,
    since: state.since,
    source: state.source,
    activeDescendants: state.activeDescendants,
    descendantsExact: state.descendantsExact,
    model: digest.model ?? state.model ?? null,
    lastTurnEnd: state.lastTurnEnd ?? null,
    lastParticipantAction: state.lastParticipantAction ?? digest.lastParticipantAction ?? null,
    pendingInteractions: (digest.pendingInteractions ?? state.pendingAsks ?? []).slice(0, CAPS.asks).map(foldAsk),
    pendingAskCount: (digest.pendingInteractions ?? state.pendingAsks ?? []).length,
    recentFailures: (digest.recentFailures ?? []).slice(0, CAPS.recentFailures).map(foldFailure),
    recentFailureCount: (digest.recentFailures ?? []).length,
    recentToolCalls: digest.recentToolCalls.slice(0, CAPS.recentTools).map(foldToolCall),
    recentToolCallCount: digest.recentToolCalls.length,
    injectionIndex: digest.injectionIndex.slice(0, CAPS.injections).map((entry) => ({
      kind: entry.kind,
      ...entry.label === void 0 ? {} : { label: preview(entry.label, 120) },
      chars: entry.chars,
      seq: entry.seq
    })),
    injectionCount: digest.injectionIndex.length,
    subagentTree: digest.subagentTree.slice(0, CAPS.subagents).map((child) => ({
      childSessionId: child.childSessionId,
      mode: child.mode,
      quiet: child.quiet,
      status: child.status,
      ...child.queryPreview === void 0 ? {} : { queryPreview: preview(child.queryPreview) }
    })),
    subagentCount: digest.subagentTree.length
  };
}
function foldSnapshot(snapshot, includeBodies) {
  const messages = snapshot.messages ?? [];
  const totalChars = messages.reduce((sum, message) => sum + (message.chars ?? 0), 0);
  const tail = messages.slice(-CAPS.snapshotMessages);
  const bodyMessages = includeBodies && snapshot.bodies !== void 0 ? snapshot.bodies.messages.slice(-BODY_MESSAGE_COUNT).map((message) => preview(JSON.stringify(message), BODY_MESSAGE_CHARS)) : void 0;
  return {
    capturedAt: snapshot.capturedAt,
    provider: snapshot.provider,
    model: snapshot.model,
    bodiesIncluded: snapshot.bodiesIncluded,
    ...snapshot.bodiesOmitted === void 0 ? {} : { bodiesOmitted: snapshot.bodiesOmitted },
    system: snapshot.system,
    tools: snapshot.tools.slice(0, CAPS.snapshotTools),
    toolCount: snapshot.tools.length,
    messageCount: messages.length,
    messageChars: totalChars,
    messageTail: tail.map((message) => ({ role: message.role, chars: message.chars })),
    ...!includeBodies || snapshot.bodies === void 0 ? {} : {
      bodies: {
        system: preview(snapshot.bodies.system ?? "", BODY_SYSTEM_CHARS) ?? null,
        tools: snapshot.bodies.tools.length,
        messages: bodyMessages
      }
    }
  };
}
function foldIncidents(incidents, sessionId) {
  if (incidents === void 0) return null;
  const items = incidents.items ?? [];
  const matching = items.filter((item) => item.sessionId === sessionId);
  const ordered = [...matching, ...items.filter((item) => item.sessionId !== sessionId)];
  return {
    generatedAt: incidents.generatedAt,
    total: items.length,
    sessionMatches: matching.length,
    items: ordered.slice(0, CAPS.incidents).map((item) => ({
      at: item.at,
      severity: item.severity,
      source: item.source,
      kind: item.kind,
      code: item.code,
      message: preview(item.message, 300),
      ...item.sessionId === void 0 ? {} : { sessionId: item.sessionId }
    }))
  };
}
function errorFacts(error) {
  if (error !== null && typeof error === "object") {
    const candidate = error;
    const code = typeof candidate.code === "string" && candidate.code !== "" ? candidate.code : void 0;
    const message = typeof candidate.message === "string" && candidate.message !== "" ? candidate.message : String(error);
    return { code: code ?? "tool/error", message: preview(message, 400) ?? "unknown failure" };
  }
  return { code: "tool/error", message: preview(String(error), 400) ?? "unknown failure" };
}

// src/source.ts
var READ_TIMEOUT_MS = 2e4;
function method(target, name2) {
  if (target === null || target === void 0) return void 0;
  const value = target[name2];
  return typeof value === "function" ? value : void 0;
}
function sourcesOver(target) {
  const digest = method(target, "digest");
  const requestSnapshot = method(target, "requestSnapshot");
  if (digest === void 0 || requestSnapshot === void 0) return void 0;
  const executionState = method(target, "executionState");
  return {
    digest: async (request) => await digest.call(target, request),
    requestSnapshot: async (request) => await requestSnapshot.call(
      target,
      request,
      AbortSignal.timeout(READ_TIMEOUT_MS)
    ),
    ...executionState === void 0 ? {} : { executionState: async (request) => await executionState.call(target, request) }
  };
}
function resolveSessionSources(ctx) {
  const controller = sourcesOver(ctx.get("sessionController"));
  if (controller !== void 0) return { ...controller, ...incidentReader(ctx) };
  const remote = ctx.get("remote");
  const client = sourcesOver(remote?.session);
  if (client !== void 0) return { ...client, ...incidentReader(ctx) };
  return void 0;
}
function incidentReader(ctx) {
  const local = ctx.get("diagnostics");
  const remote = ctx.get("remote")?.diagnostics;
  const target = method(local, "list") !== void 0 ? local : method(remote, "list") !== void 0 ? remote : void 0;
  const list = method(target, "list");
  if (target === void 0 || list === void 0) return {};
  return {
    incidents: async (limit) => await list.call(target, { limit })
  };
}

// src/tools.ts
var SESSION_DEBUG_TOOL_NAME = "session_debug";
var INCLUDE_BODIES_REASON = "session_debug includeBodies exposes the raw system prompt and message bodies";
var INCLUDE_SECTIONS = ["digest", "snapshot", "incidents"];
var DESCRIPTION = [
  "Read one Session's debug/transparency surface (doc 69 \xA79.1): execution latch, current model, pending asks,",
  "the last turn end with its structured error, bounded recent tool calls with previews, the injection index, the",
  "subagent tree, the main-model request summary, and (optionally) the diagnostics incident tail. Read-only \u2014 it",
  "never prompts, mutates, or writes the session log. Omit sessionId to inspect the calling session itself; pass",
  "one only to inspect another Session, which must be attached (otherwise session/not-found). Bodies are excluded",
  "unless includeBodies:true is passed explicitly AND the local operator grants allowed-once on the resulting",
  "approval card; that flag is HEAVY and secret-bearing (full system prompt, tool schemas, message text)."
].join(" ");
var OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    sessionId: { type: "string" },
    include: { type: "array", items: { type: "string" } },
    notes: { type: "array", items: { type: "string" } },
    error: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: { code: { type: "string" }, message: { type: "string" } },
          required: ["code", "message"]
        }
      ]
    },
    digest: { oneOf: [{ type: "null" }, { type: "object", additionalProperties: true }] },
    snapshot: { oneOf: [{ type: "null" }, { type: "object", additionalProperties: true }] },
    incidents: { oneOf: [{ type: "null" }, { type: "object", additionalProperties: true }] }
  },
  required: ["ok", "sessionId", "include", "notes", "error", "digest", "snapshot", "incidents"]
};
function parseSessionDebugArgs(args) {
  const request = args ?? {};
  const rawSessionId = request.sessionId;
  const sessionId = typeof rawSessionId === "string" && rawSessionId.trim() !== "" ? rawSessionId.trim() : void 0;
  if (rawSessionId !== void 0 && sessionId === void 0) {
    const error = new Error("session_debug: sessionId must be a non-empty string when provided");
    error.code = "gateway/bad-request";
    throw error;
  }
  const requested = Array.isArray(request.include) ? request.include.filter((entry) => INCLUDE_SECTIONS.includes(entry)) : [];
  return {
    sessionId,
    include: requested.length > 0 ? requested : ["digest"],
    recentTools: clampRecentTools(request.recentTools),
    includeBodies: request.includeBodies === true
  };
}
async function approveIncludeBodies(ctx, exec) {
  if (exec?.agent === void 0) return "unavailable";
  const approval = ctx.get("approval");
  if (approval === void 0) return "unavailable";
  try {
    return await approval.request({
      agent: exec.agent,
      toolName: SESSION_DEBUG_TOOL_NAME,
      ...exec.callId === void 0 ? {} : { callId: exec.callId },
      reason: INCLUDE_BODIES_REASON,
      signal: exec.signal
    });
  } catch {
    return "unavailable";
  }
}
function callerSessionId(exec) {
  const agent = exec?.agent;
  if (agent === void 0) return void 0;
  const sessionId = agent.session?.id ?? agent.id;
  return sessionId === void 0 ? void 0 : String(sessionId);
}
function registerSessionDebugTool(ctx, options = {}) {
  const resolve = options.resolve ?? (() => resolveSessionSources(ctx));
  ctx.tools.register({
    name: SESSION_DEBUG_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Durable Session identity to inspect. Omit to inspect the calling session (this Agent's own Session); a provided id must name an attached Session or the call returns session/not-found." },
        include: {
          type: "array",
          items: { type: "string", enum: [...INCLUDE_SECTIONS] },
          description: "Sections to read; default ['digest']. `snapshot` is the main-model request summary (bodies only with includeBodies + operator approval). `incidents` is the diagnostics tail."
        },
        recentTools: { type: "number", description: "Recent tool calls to include (1..50, default 10)." },
        includeBodies: {
          type: "boolean",
          description: "HEAVY + SECRET-BEARING: also return the captured system prompt, tool schemas, and message bodies. Requires an explicit allowed-once approval from the local operator (anything else refuses the bodies). Only pass this when the raw request must be inspected; never echo credentials from it."
        }
      }
      // sessionId is optional: omission means "the calling session".
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: "text", text: renderSessionDebug(value) }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      let request;
      try {
        request = parseSessionDebugArgs(args);
      } catch (error) {
        const facts = errorFacts(error);
        return {
          ok: false,
          sessionId: typeof args?.sessionId === "string" ? String(args.sessionId) : "",
          include: [],
          notes: [],
          error: facts,
          digest: null,
          snapshot: null,
          incidents: null
        };
      }
      const sessionId = request.sessionId ?? callerSessionId(exec);
      if (sessionId === void 0) {
        return {
          ok: false,
          sessionId: "",
          include: request.include,
          notes: [],
          error: { code: "gateway/bad-request", message: "session_debug: sessionId was omitted and the calling Agent has no Session" },
          digest: null,
          snapshot: null,
          incidents: null
        };
      }
      try {
        const sources = resolve();
        if (sources === void 0) {
          return {
            ok: false,
            sessionId,
            include: request.include,
            notes: ["no session read surface is present in this process"],
            error: { code: "debug/unavailable", message: "sessionController/remote.session with digest+requestSnapshot is unavailable" },
            digest: null,
            snapshot: null,
            incidents: null
          };
        }
        const notes = [];
        const digest = request.include.includes("digest") ? foldDigest(await sources.digest({ sessionId, recentTools: request.recentTools })) : null;
        let snapshot = null;
        if (request.include.includes("snapshot")) {
          let includeBodies = request.includeBodies;
          if (includeBodies) {
            const outcome = await approveIncludeBodies(ctx, exec);
            if (outcome === "allowed-once") {
              notes.push("includeBodies=true: the secret-bearing request bodies are included below; never echo credentials from them.");
            } else {
              includeBodies = false;
              notes.push(`includeBodies refused (${outcome}): the raw system prompt and message bodies were not read or returned; the summary below excludes them.`);
            }
          } else {
            notes.push("snapshot bodies excluded (pass includeBodies:true explicitly to read them).");
          }
          snapshot = foldSnapshot(await sources.requestSnapshot({ sessionId, includeBodies }), includeBodies);
        }
        let incidents = null;
        if (request.include.includes("incidents")) {
          if (sources.incidents === void 0) notes.push("diagnostics service unavailable: incidents excluded.");
          else incidents = foldIncidents(await sources.incidents(25), sessionId);
        }
        return { ok: true, sessionId, include: request.include, notes, error: null, digest, snapshot, incidents };
      } catch (error) {
        return {
          ok: false,
          sessionId,
          include: request.include,
          notes: [],
          error: errorFacts(error),
          digest: null,
          snapshot: null,
          incidents: null
        };
      }
    }
  });
}
function renderSessionDebug(value) {
  const result = value;
  if (result.ok !== true) {
    return `session_debug FAILED ${result.error?.code ?? "unknown"}: ${result.error?.message ?? "no detail"}`;
  }
  const lines = [`session_debug ${result.sessionId} (${(result.include ?? []).join(", ")})`];
  const digest = result.digest;
  if (digest !== null && digest !== void 0) {
    const model = digest.model;
    lines.push(`  latch=${String(digest.latch)} since=${String(digest.since)} descendants=${String(digest.activeDescendants)}${digest.descendantsExact === false ? " (inexact)" : ""}${model == null ? "" : ` model=${model.provider ?? "?"}/${model.model ?? "?"}`}`);
    const last = digest.lastTurnEnd;
    if (last !== null && last !== void 0) {
      lines.push(`  last turn end: turn ${String(last.turn)} ${String(last.reason)}${last.error === void 0 ? "" : ` \u2014 ${last.error.code}: ${last.error.message}`}`);
    }
    const asks = digest.pendingInteractions ?? [];
    lines.push(`  pending asks (${String(digest.pendingAskCount ?? asks.length)})`);
    for (const ask of asks) {
      lines.push(ask.kind === "approval" ? `    \xB7 approval ${String(ask.askId)} tool=${String(ask.toolName)}${ask.reason === void 0 ? "" : ` reason="${String(ask.reason)}"`}` : `    \xB7 question ${String(ask.askId)}`);
    }
    const failures = digest.recentFailures ?? [];
    if (failures.length > 0) {
      lines.push(`  recent failures (${String(digest.recentFailureCount ?? failures.length)})`);
      for (const failure of failures) {
        lines.push(`    \xB7 ${String(failure.provider)}/${String(failure.model)} ${String(failure.code)}: ${String(failure.message)}${failure.next === void 0 ? "" : ` \u2192 next ${String(failure.next)}`}`);
      }
    }
    const calls = digest.recentToolCalls ?? [];
    lines.push(`  recent tools (${String(digest.recentToolCallCount ?? calls.length)})`);
    for (const call of calls) {
      const error = call.error;
      lines.push(`    \xB7 ${String(call.status)} ${String(call.tool)}${error === void 0 ? "" : ` \u2014 ${error.name}:${error.code}`}`);
    }
    const injections = digest.injectionIndex ?? [];
    lines.push(`  injections (${String(digest.injectionCount ?? injections.length)}): ${injections.map((entry) => String(entry.kind)).join(", ")}`);
    const tree = digest.subagentTree ?? [];
    lines.push(`  subagents (${String(digest.subagentCount ?? tree.length)})`);
    for (const child of tree) {
      lines.push(`    \xB7 ${String(child.childSessionId)} mode=${String(child.mode)} quiet=${String(child.quiet)} status=${String(child.status)}`);
    }
  }
  const snapshot = result.snapshot;
  if (snapshot !== null && snapshot !== void 0) {
    lines.push(`  request: ${String(snapshot.provider)}/${String(snapshot.model)} tools=${String(snapshot.toolCount)} messages=${String(snapshot.messageCount)} (${String(snapshot.messageChars)} chars) bodies=${String(snapshot.bodiesIncluded)}`);
  }
  const incidents = result.incidents;
  if (incidents !== null && incidents !== void 0) {
    lines.push(`  incidents (${String(incidents.sessionMatches ?? 0)} for this session / ${String(incidents.total ?? 0)} total)`);
    for (const item of incidents.items ?? []) {
      lines.push(`    \xB7 [${String(item.severity)}] ${String(item.code)} \u2014 ${String(item.message)}`);
    }
  }
  for (const note of result.notes ?? []) lines.push(`  note: ${note}`);
  return lines.join("\n");
}

// src/index.ts
var name = "enpoi-debug";
var inject = ["tools"];
function apply(ctx) {
  if (typeof ctx.tools?.register !== "function") {
    ctx.logger?.warn("enpoi-debug: tools service unavailable; session_debug not registered");
    return;
  }
  registerSessionDebugTool(ctx);
  process.stderr.write("[enpoi-debug] mounted (session_debug registered in this agent scope)\n");
}
export {
  CAPS,
  INCLUDE_BODIES_REASON,
  PREVIEW_CHARS,
  SESSION_DEBUG_TOOL_NAME,
  apply,
  clampRecentTools,
  foldDigest,
  foldFailure,
  foldIncidents,
  foldSnapshot,
  incidentReader,
  inject,
  name,
  parseSessionDebugArgs,
  registerSessionDebugTool,
  renderSessionDebug,
  resolveSessionSources
};
