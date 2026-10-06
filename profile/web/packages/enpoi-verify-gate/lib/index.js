// src/index.ts
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import Schema from "@deepseek-ai/schemastery";
import { readOrchestrationDocument } from "dsh-enpoi-contracts";

// src/verify.ts
var VERIFY_UNMET_EVENT = "verify/unmet";
var DEFAULT_GATE_CONFIG = Object.freeze({ mode: "record", promptOnce: false });
var VERIFICATION_TOOLS = /* @__PURE__ */ new Set(["bash", "pwsh", "str_replace_editor"]);
var CONTROL_PLANE_TOOLS = /* @__PURE__ */ new Set([
  "subagent",
  "task",
  "create_goal",
  "get_goal",
  "update_goal",
  "send_message",
  "interrupt_agent",
  "list_agents"
]);
var PREVIEW_CHARS = 200;
var FAILURE_TEXT_PATTERN = /\[exit code:\s*[1-9][0-9]*\]|\bFAILED\b|AssertionError|Traceback \(most recent call last\)|\b(?:npm|pnpm|yarn) ERR!|\bcommand not found\b|^\s*Error:/;
var ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function readExitCode(meta) {
  const record = asRecord(meta);
  if (record === void 0 || !("exitCode" in record)) return void 0;
  const value = record.exitCode;
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return void 0;
}
function previewFailureText(text, max = PREVIEW_CHARS) {
  if (typeof text !== "string" || text === "") return "";
  const lines = text.replaceAll(ANSI_PATTERN, "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  const chosen = lines.find((line) => FAILURE_TEXT_PATTERN.test(line)) ?? lines.at(-1) ?? "";
  const collapsed = chosen.replaceAll(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}\u2026`;
}
function observeToolResult(facts) {
  const tool = typeof facts.tool === "string" && facts.tool !== "" ? facts.tool : "unknown";
  const turn = typeof facts.turn === "number" && Number.isFinite(facts.turn) ? Math.trunc(facts.turn) : 0;
  if (CONTROL_PLANE_TOOLS.has(tool)) return void 0;
  const exitCode = readExitCode(facts.meta);
  const errorRecord = asRecord(facts.error);
  const structuredError = errorRecord !== void 0;
  if (!VERIFICATION_TOOLS.has(tool) && !structuredError && exitCode === void 0) return void 0;
  const callId = typeof facts.callId === "string" && facts.callId !== "" ? facts.callId : void 0;
  const base = {
    turn,
    tool,
    ...callId === void 0 ? {} : { callId }
  };
  if (exitCode !== void 0 && exitCode !== 0) {
    return {
      turn,
      failure: {
        ...base,
        exitCode,
        reason: "exit-code",
        messagePreview: previewFailureText(facts.text)
      }
    };
  }
  if (structuredError) {
    const reason = typeof errorRecord.reason === "string" && errorRecord.reason !== "" ? errorRecord.reason : void 0;
    return {
      turn,
      failure: {
        ...base,
        ...exitCode === void 0 ? {} : { exitCode },
        reason: "tool-error",
        messagePreview: previewFailureText(reason ?? facts.text)
      }
    };
  }
  if (facts.isError === true) {
    return {
      turn,
      failure: {
        ...base,
        ...exitCode === void 0 ? {} : { exitCode },
        reason: "is-error",
        messagePreview: previewFailureText(facts.text)
      }
    };
  }
  if (typeof facts.text === "string" && FAILURE_TEXT_PATTERN.test(facts.text)) {
    return {
      turn,
      failure: {
        ...base,
        ...exitCode === void 0 ? {} : { exitCode },
        reason: "failure-text",
        messagePreview: previewFailureText(facts.text)
      }
    };
  }
  return { turn };
}
var MAX_TRACKED_SESSIONS = 500;
var VerifyGateTracker = class {
  sessions = /* @__PURE__ */ new Map();
  /**
   * Record one observed (verification-ish) tool result.
   * @param sessionId - owning session.
   * @param observation - classification from {@link observeToolResult}; a
   *   non-verification result must be passed as `undefined`.
   */
  noteToolResult(sessionId, observation) {
    if (observation === void 0) return;
    const state = this.state(sessionId);
    if (observation.turn < state.lastTurn) return;
    state.lastTurn = observation.turn;
    if (observation.failure === void 0) delete state.last;
    else state.last = observation.failure;
  }
  /**
   * Decide what one turn ending means.
   *
   * Records only when the turn ended `completed` AND its last verification-ish
   * result failed. A second consecutive unverified ending is recorded, never
   * re-prompted; any other ending (verified, aborted, error, …) resets the
   * streak. The per-turn failure is consumed, so a duplicate boundary cannot
   * double-record.
   * @param input - turn terminal facts plus the resolved config.
   * @returns the record to persist and whether to inject one follow-up.
   */
  noteTurnEnd(input) {
    const state = this.sessions.get(input.sessionId);
    if (state === void 0) return { prompt: false };
    const failure = state.lastTurn === input.turn ? state.last : void 0;
    delete state.last;
    if (input.reason !== "completed" || failure === void 0) {
      state.promptedUnverified = 0;
      return { prompt: false };
    }
    const record = {
      turn: failure.turn,
      tool: failure.tool,
      ...failure.callId === void 0 ? {} : { callId: failure.callId },
      ...failure.exitCode === void 0 ? {} : { exitCode: failure.exitCode },
      reason: failure.reason,
      messagePreview: failure.messagePreview
    };
    let prompt = false;
    if (input.config.mode === "prompt") {
      const allowed = state.promptedUnverified < 1 && (!input.config.promptOnce || !state.promptedEver);
      if (allowed) {
        prompt = true;
        state.promptedEver = true;
      }
      state.promptedUnverified = Math.min(state.promptedUnverified + 1, 2);
    }
    return { record, prompt };
  }
  /** Read one session's state (tests/diagnostics); never creates one. */
  stateOf(sessionId) {
    return this.sessions.get(sessionId);
  }
  state(sessionId) {
    let state = this.sessions.get(sessionId);
    if (state === void 0) {
      state = { lastTurn: -1, promptedUnverified: 0, promptedEver: false };
      this.sessions.set(sessionId, state);
      if (this.sessions.size > MAX_TRACKED_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== void 0 && oldest !== sessionId) this.sessions.delete(oldest);
      }
    }
    return state;
  }
};

// src/index.ts
var name = "enpoi-verify-gate";
var inject = [];
function live(schema) {
  return schema.volatile?.() ?? schema;
}
function plainConfig(config) {
  const out = {};
  for (const [key, field] of Object.entries(config)) {
    out[key] = typeof field?.get === "function" ? field.get() : field;
  }
  return out;
}
var Config = Schema.object({
  mode: live(Schema.union(["record", "prompt"]).default("record")),
  promptOnce: live(Schema.boolean().default(false))
});
var GATE_SETTINGS_NAMESPACE = "enpoi-orchestration";
var MAX_REMEMBERED_CALLS = 500;
var FOLLOWUP_PREFIX = "Your last verification failed \u2014 continue the work or explain why the turn is done.";
function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
function asRecord2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function resolveGateConfig(ctx, config = {}) {
  config = plainConfig(config);
  const fallback = {
    mode: config.mode === "prompt" ? "prompt" : "record",
    promptOnce: config.promptOnce === true
  };
  try {
    const doc = readOrchestrationDocument(ctx.get("settings"));
    const gate = doc?.parameters?.verifyGate;
    if (gate === null || typeof gate !== "object") return fallback;
    return {
      mode: gate.mode === "prompt" ? "prompt" : gate.mode === "record" ? "record" : fallback.mode,
      promptOnce: typeof gate.promptOnce === "boolean" ? gate.promptOnce : fallback.promptOnce
    };
  } catch {
    return fallback;
  }
}
function extractToolResultFacts(data) {
  const message = asRecord2(data.message);
  const source = asRecord2(message?.source);
  const callIdRaw = typeof data.callId === "string" ? data.callId : typeof message?.toolCallId === "string" ? message.toolCallId : source?.callId;
  const callId = typeof callIdRaw === "string" && callIdRaw !== "" ? callIdRaw : void 0;
  const turn = typeof data.turn === "number" && Number.isFinite(data.turn) ? Math.trunc(data.turn) : void 0;
  const isError = typeof message?.isError === "boolean" ? message.isError : void 0;
  const texts = [];
  const content = Array.isArray(message?.content) ? message.content : [];
  for (const blockRaw of content) {
    const block = asRecord2(blockRaw);
    if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
  }
  return {
    ...turn === void 0 ? {} : { turn },
    ...callId === void 0 ? {} : { callId },
    ...isError === void 0 ? {} : { isError },
    text: texts.join("\n"),
    error: data.error,
    meta: data.meta
  };
}
function appendIgnorable(session, type, data) {
  const append = session?.append;
  if (typeof append !== "function") return;
  append.call(session, type, data, { ignorable: true });
}
function reportIncident(ctx, record, sessionId) {
  try {
    const diagnostics = ctx.get("diagnostics");
    if (typeof diagnostics?.report !== "function") return void 0;
    const exit = record.exitCode === void 0 ? "" : ` exitCode=${String(record.exitCode)}`;
    const result = diagnostics.report({
      kind: "verify-unmet",
      message: `verify/unmet: ${record.tool} ${record.reason}${exit} turn=${record.turn} ${record.messagePreview}`,
      sessionId
    });
    return typeof result?.code === "string" ? result.code : void 0;
  } catch {
    return void 0;
  }
}
function injectFollowup(ctx, sessionId, record) {
  try {
    const agents = ctx.get("agents");
    const agent = agents?.get?.(sessionId);
    if (agent === void 0 || typeof agent.followup !== "function") return false;
    const exit = record.exitCode === void 0 ? "" : ` (${record.tool}, exit ${String(record.exitCode)})`;
    const message = createUserMessage({
      content: [{ type: "text", text: `${FOLLOWUP_PREFIX}${exit}` }],
      source: {
        kind: "enpoi-verify-gate",
        form: "notice",
        summary: `verification unmet (${record.tool})`
      }
    });
    agent.followup(message);
    return true;
  } catch (error) {
    process.stderr.write(`[enpoi-verify-gate] follow-up injection failed: ${errorText(error)}
`);
    return false;
  }
}
function deliver(ctx, session, record, prompt) {
  const sessionId = session?.id;
  const id = typeof sessionId === "string" && sessionId !== "" ? sessionId : "unknown";
  const exit = record.exitCode === void 0 ? "" : ` exitCode=${String(record.exitCode)}`;
  const line = `verify/unmet session=${id} turn=${record.turn} tool=${record.tool} reason=${record.reason}${exit} preview="${record.messagePreview}"`;
  try {
    appendIgnorable(session, VERIFY_UNMET_EVENT, record);
  } catch (error) {
    process.stderr.write(`[enpoi-verify-gate] append failed: ${errorText(error)}
`);
  }
  process.stderr.write(`[enpoi-verify-gate] ${line}
`);
  try {
    ctx.logger?.info?.(`enpoi-verify-gate: ${line}`);
  } catch {
  }
  const code = reportIncident(ctx, record, id);
  if (code !== void 0) {
    process.stderr.write(`[enpoi-verify-gate] reported diagnostics incident ${code} for ${id}
`);
  }
  if (prompt) {
    const injected = injectFollowup(ctx, id, record);
    process.stderr.write(
      `[enpoi-verify-gate] prompt mode: follow-up ${injected ? "injected" : "not injected (no live agent)"} for ${id}
`
    );
  }
}
function apply(ctx, config = {}, options = {}) {
  config = plainConfig(config);
  try {
    const tracker = new VerifyGateTracker();
    const calls = /* @__PURE__ */ new Map();
    const defer = options.defer ?? ((task) => {
      const timer = setTimeout(task, 0);
      timer.unref?.();
    });
    const listener = (session, event) => {
      try {
        const data = asRecord2(event.data) ?? {};
        switch (event.type) {
          case "tool/call": {
            const callId = typeof data.callId === "string" ? data.callId : void 0;
            const tool = typeof data.name === "string" && data.name !== "" ? data.name : "unknown";
            if (callId === void 0) return;
            calls.set(callId, tool);
            if (calls.size > MAX_REMEMBERED_CALLS) {
              const oldest = calls.keys().next().value;
              if (oldest !== void 0) calls.delete(oldest);
            }
            return;
          }
          case "tool/result": {
            const facts = extractToolResultFacts(data);
            const callId = typeof facts.callId === "string" ? facts.callId : void 0;
            const sessionId = typeof session.id === "string" && session.id !== "" ? session.id : void 0;
            if (sessionId === void 0) return;
            tracker.noteToolResult(sessionId, observeToolResult({
              ...facts,
              ...callId === void 0 ? {} : { tool: calls.get(callId) }
            }));
            return;
          }
          case "turn/end": {
            const sessionId = typeof session.id === "string" && session.id !== "" ? session.id : void 0;
            const turn = typeof data.turn === "number" && Number.isFinite(data.turn) ? Math.trunc(data.turn) : void 0;
            if (sessionId === void 0 || turn === void 0) return;
            const reasonRecord = asRecord2(data.reason);
            const reason = typeof reasonRecord?.kind === "string" ? reasonRecord.kind : "unknown";
            const decision = tracker.noteTurnEnd({
              sessionId,
              turn,
              reason,
              config: resolveGateConfig(ctx, config)
            });
            if (decision.record === void 0) return;
            const { record, prompt } = decision;
            defer(() => {
              deliver(ctx, session, record, prompt);
            });
            return;
          }
          default:
            return;
        }
      } catch (error) {
        process.stderr.write(`[enpoi-verify-gate] listener failure swallowed: ${errorText(error)}
`);
      }
    };
    ctx.on("session/event", listener);
    process.stderr.write(
      `[enpoi-verify-gate] mounted (mode=${config.mode ?? "record"} fallback; switch: ${GATE_SETTINGS_NAMESPACE}.parameters.verifyGate)
`
    );
    ctx.logger?.info?.(
      `enpoi-verify-gate: mounted (record-only unless ${GATE_SETTINGS_NAMESPACE}.parameters.verifyGate sets mode=prompt)`
    );
  } catch (error) {
    process.stderr.write(`[enpoi-verify-gate] disabled \u2014 ${errorText(error)}
`);
  }
}
export {
  CONTROL_PLANE_TOOLS,
  Config,
  DEFAULT_GATE_CONFIG,
  FAILURE_TEXT_PATTERN,
  GATE_SETTINGS_NAMESPACE,
  MAX_TRACKED_SESSIONS,
  PREVIEW_CHARS,
  VERIFICATION_TOOLS,
  VERIFY_UNMET_EVENT,
  VerifyGateTracker,
  appendIgnorable,
  apply,
  extractToolResultFacts,
  inject,
  name,
  observeToolResult,
  previewFailureText,
  readExitCode,
  resolveGateConfig
};
