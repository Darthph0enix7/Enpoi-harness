// src/index.ts
import Schema from "@deepseek-ai/schemastery";
import { createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { queueHostSubagentPrompt as queueHostSubagentPrompt2 } from "@deepseek-ai/dsh-subagent/internal";
import { getBriefService } from "dsh-enpoi-context-keeper";
import { readOrchestrationDocument } from "dsh-enpoi-contracts";

// src/ask-child.ts
import { queueHostSubagentPrompt } from "@deepseek-ai/dsh-subagent/internal";
var ChildTurnTimeoutError = class extends Error {
  /**
   * @param childId - the still-running child whose turn was abandoned.
   * @param messageId - the prompt message that never settled.
   */
  constructor(childId, messageId) {
    super(`child ${childId} did not settle message ${messageId} before the deadline`);
    this.childId = childId;
    this.messageId = messageId;
    this.name = "ChildTurnTimeoutError";
  }
};
function textOfContent(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks.map((block) => {
    if (typeof block !== "object" || block === null || !("text" in block)) return "";
    const blockType = block.type;
    return blockType === "text" || blockType === void 0 ? String(block.text) : "";
  }).filter((text) => text.length > 0).join(" ");
}
var STOP_REASONS = /* @__PURE__ */ new Set(["completed", "error", "aborted", "max-tokens", "refusal"]);
function stopReasonOf(reason) {
  const kind = String(reason.kind);
  return STOP_REASONS.has(kind) ? kind : "error";
}
function errorOf(reason) {
  if (reason.kind !== "error") return void 0;
  return reason.error.message;
}
async function readSettledTurn(ctx, childId, messageId) {
  const persistence = ctx.get("sessionPersistence");
  if (persistence === void 0) return void 0;
  const handle = await persistence.open(childId, "read");
  let events;
  try {
    events = (await handle.read(0, void 0)).events;
  } finally {
    await handle.close();
  }
  const start = events.findIndex((event) => event.type === "user/message" && event.data.id === messageId);
  if (start < 0) return void 0;
  const parts = [];
  for (let index = start + 1; index < events.length; index += 1) {
    const event = events[index];
    if (event.type === "assistant/message") {
      const text = textOfContent(event.data.message.content);
      if (text.length > 0) parts.push(text);
      continue;
    }
    if (event.type === "turn/end") {
      const error = errorOf(event.data.reason);
      return {
        messageId,
        text: parts.join("\n"),
        stopReason: stopReasonOf(event.data.reason),
        ...error === void 0 ? {} : { error }
      };
    }
    if (event.type === "user/message") return void 0;
  }
  return void 0;
}
function abortError(signal) {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}
async function waitForChildMessageTurn(ctx, childId, messageId, options) {
  const { signal, deadline, pollMs } = options;
  if (ctx.get("sessionPersistence") === void 0) {
    throw new Error("waitForChildMessageTurn requires the sessionPersistence service");
  }
  let wake;
  const nudge = () => {
    wake?.();
  };
  const onEnd = (info) => {
    if (info.id === childId) nudge();
  };
  const off = ctx.on("subagent/end", onEnd);
  signal.addEventListener("abort", nudge, { once: true });
  try {
    for (; ; ) {
      if (signal.aborted) throw abortError(signal);
      if (ctx.agents.get(childId) === void 0) {
        const settled = await readSettledTurn(ctx, childId, messageId);
        if (settled !== void 0) return settled;
      }
      if (signal.aborted) throw abortError(signal);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ChildTurnTimeoutError(childId, messageId);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.max(1, Math.min(pollMs, remaining)));
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  } finally {
    off();
    signal.removeEventListener("abort", nudge);
  }
}
async function askChild(ctx, parent, childId, content, options) {
  const messageId = await queueHostSubagentPrompt(
    ctx.subagents,
    parent,
    childId,
    content,
    { kind: "user" },
    options.signal
  );
  return waitForChildMessageTurn(ctx, childId, messageId, options);
}

// src/queue.ts
var ParentFifoQueue = class {
  tails = /* @__PURE__ */ new Map();
  /**
   * Run one task after every earlier task enqueued under the same key settled.
   * @param key - parent session id owning the lane.
   * @param task - work that must not overlap another task on this lane.
   * @returns the task's value or rejection, unchanged.
   */
  async run(key, task) {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release = () => {
    };
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    try {
      await previous;
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
  /**
   * Read whether tasks are queued or running on one lane.
   * @param key - parent session id.
   * @returns whether a lane entry exists.
   */
  isBusy(key) {
    return this.tails.has(key);
  }
};

// src/index.ts
var name = "enpoi-oracle";
var inject = ["tools", "subagents", "sessionPersistence", "agents"];
var Config = Schema.object({
  childPollMs: Schema.number().min(100).default(1e3)
});
var ORACLE_LABEL = "oracle";
var ORACLE_PERSONA = [
  "You are the Oracle \u2014 senior architectural supervisor, conceptual thinker, and deep reviewer.",
  "You reason independently and deeply: you evaluate architecture, concepts, system trade-offs, logic, race conditions, and code.",
  "You are an advisor, not a dictator: if a plan is flawed, over-engineered, or heading in the wrong direction, say so plainly.",
  "When reviewing code, inspect relevant files directly using your search/read tools as needed to understand the broader context. When reviewing concepts or plans, evaluate feasibility, modularity, and trade-offs.",
  "This is a persistent reviewer session for the whole operator session: reuse your accumulated context and earlier verdicts across consultations; when a consultation names a new operator query, re-ground on it.",
  "You may call request_evidence(target, question) at any point \u2014 it sends a research child (codebase explorer or web librarian) to fetch ground truth and returns a short cited fact sheet. Ask as many or as few questions as your judgment requires; use it whenever first-hand verification would sharpen your review, and ignore it entirely when you already know enough.",
  "You never write or edit files. You never paste whole files back \u2014 you summarize, explain, and cite.",
  "End every review with a VERDICT BLOCK in exactly this JSON \u2014 the orchestrator parses it mechanically, so it must be the LAST thing you output and must be valid JSON:",
  '{"approved":true|false,"concerns":["..."],"unverified":["..."],"blockers":["..."]}'
].join("\n");
var ORACLE_TOOL_FILTER = {
  // Read-only review surface. Passed UNCONDITIONALLY: the fork's
  // `tools.restrict()` skips unknown deny names, while the previous
  // `.filter(name => ctx.tools.get(name) !== undefined)` guard dropped every
  // tool registered outside this plugin's context and silently left the child
  // with the full main surface (verified live: 29 tools).
  // NOTE: `run_code` is never named — the PTC presentation transport is
  // reserved and `tools.restrict()` throws when a filter names it.
  deny: [
    // The Oracle MAY delegate: it can spawn subagents (fixer/explorer/…)
    // and use the request_evidence broker — judgment work only, no mutations
    // (write tools stay denied below).
    "oracle_review",
    "dispatch_task",
    "subagent_codex",
    "subagent_claude_code",
    "roundtable",
    "chorus",
    "create_goal",
    "get_goal",
    "update_goal",
    "exit_plan_mode",
    "plan_mode",
    "goal",
    "ralph",
    "workflow",
    "job_output",
    "job_list",
    "job_kill",
    "ask_user_question",
    "send_message",
    "interrupt_agent",
    "list_agents",
    // Harness authoring is the creator seat's own surface; the seat guard
    // refuses it to an orchestrator/sysadmin-parented oracle child. `review_run`
    // stays available: the Oracle IS a reviewer seat (REVIEW_ROLES /
    // descriptor persona), and `subagent` stays by design (its own researchers).
    "plugin_manager",
    "cordis_inspect_list",
    "cordis_inspect_query"
  ]
};
var EVIDENCE_RESEARCH_PERSONA = [
  "You are a precision research assistant. You answer EXACTLY the question asked, from the codebase (read/glob/grep) or the web (web_search), and nothing else.",
  "Output a FACT SHEET and nothing more:",
  "CITATION: the ACTUAL file path with line number, or the exact URL you read \u2014 never a placeholder.",
  "FACTS: the answer, maximum 150 words, only what the question asked.",
  "CONFIDENCE: high | medium | low",
  'Never speculate. If the answer is not findable, its FACTS say "NOT FINDABLE" and the CITATION shows the closest place you looked.'
].join("\n");
function parseEvidenceSheet(text) {
  const plain = text.replace(/\*\*/g, "");
  const rawCitation = plain.match(/CITATION\s*[:=]\s*(.+)/i)?.[1]?.trim();
  const facts = plain.match(/FACTS\s*[:=]\s*([\s\S]*?)(?:CONFIDENCE\s*[:=]|$)/i)?.[1]?.trim();
  const confidence = plain.match(/CONFIDENCE\s*[:=]\s*(high|medium|low)/i)?.[1]?.toLowerCase();
  if (!rawCitation || !facts) return null;
  const placeholder = /<file:line|url\s*—|— exact>|your citation/i.test(rawCitation);
  return {
    citation: placeholder ? "unverified (research child echoed the template)" : rawCitation,
    facts,
    confidence: placeholder ? "low" : confidence ?? "medium"
  };
}
function isExternalEvidenceTarget(target) {
  return /\b(web|http|npm|docs?|librar|package|registry|external|api)\b/i.test(target);
}
function lastHumanUserMessageSeq(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type !== "user/message") continue;
    if (event.data.source?.kind === "user") return event.seq;
  }
  return 0;
}
function latestOperatorQuery(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type !== "user/message") continue;
    if (event.data.source?.kind !== "user") continue;
    const text = textOfContent(event.data.content).trim();
    return text.length > 1e3 ? text.slice(0, 1e3) : text;
  }
  return "";
}
function readLivingBrief(ctx, session) {
  try {
    const projections = ctx.get("sessionProjections");
    if (projections === void 0) return null;
    const snapshot = projections.snapshot(session);
    const view = snapshot.values?.livingBrief;
    if (view === void 0 || view === null) return null;
    const prose = typeof view.prose === "object" && view.prose !== null ? view.prose : null;
    const freshness = typeof view.freshness === "string" ? view.freshness : "stale";
    const parts = [
      view.goal !== void 0 && view.goal !== "" ? `Goal: ${String(view.goal)}` : null,
      Array.isArray(view.decisions) && view.decisions.length > 0 ? `Decisions: ${view.decisions.map((d) => d.text).join("; ")}` : null,
      Array.isArray(view.openThreads) && view.openThreads.length > 0 ? `Open threads: ${view.openThreads.map((t) => t.text).join("; ")}` : null,
      prose !== null ? `Keeper synthesis: ${String(prose.text)}` : null,
      `Brief freshness: ${freshness}`
    ].filter((part) => part !== null);
    return parts.length > 0 ? parts.join("\n") : null;
  } catch {
    return null;
  }
}
function extractWhiteboardSummary(doc, sessionId, cwd) {
  try {
    const wb = doc?.whiteboard;
    if (!wb?.docs) return null;
    const entries = [];
    const seen = /* @__PURE__ */ new Set();
    const pushEntries = (rawList) => {
      if (!Array.isArray(rawList)) return;
      for (const e of rawList) {
        const text = typeof e?.text === "string" ? e.text.trim() : "";
        if (text.length === 0 || seen.has(text)) continue;
        seen.add(text);
        entries.push({
          kind: typeof e.kind === "string" ? e.kind : "fact",
          text,
          pinned: e.pinned === true
        });
      }
    };
    pushEntries(wb.docs.global?.entries);
    if (cwd && wb.docs.projects?.[cwd]?.entries) pushEntries(wb.docs.projects[cwd].entries);
    if (sessionId && wb.docs.sessions?.[sessionId]?.entries) pushEntries(wb.docs.sessions[sessionId].entries);
    if (entries.length === 0) return null;
    entries.sort((a, b) => a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1);
    const lines = entries.map((e) => `- ${e.pinned ? "\u{1F4CC} " : ""}[${e.kind}] ${e.text}`);
    return lines.join("\n");
  } catch {
    return null;
  }
}
function buildInitialPackage(input) {
  const lines = [
    "You are the Oracle \u2014 the senior architectural supervisor and deep reviewer.",
    "This is a persistent consultation session for this operator session; later consultations arrive as deltas."
  ];
  if (input.whiteboard) lines.push("--- PINNED WHITEBOARD ---", input.whiteboard);
  if (input.brief !== null && input.brief !== void 0) lines.push("--- SESSION BRIEF ---", input.brief);
  lines.push("--- REVIEW REQUEST ---", input.request);
  if (input.files !== void 0 && input.files.length > 0) {
    lines.push("--- READING LIST (read these files directly) ---");
    for (const file of input.files) lines.push(`- ${file}`);
  }
  return lines.join("\n");
}
function buildDelta(input) {
  const lines = [];
  if (input.operatorQuery) lines.push("--- NEW OPERATOR QUERY ---", input.operatorQuery);
  if (input.whiteboard) lines.push("--- PINNED WHITEBOARD ---", input.whiteboard);
  if (input.brief) lines.push("--- CURRENT SESSION BRIEF ---", input.brief);
  lines.push("--- REVIEW REQUEST ---", input.request);
  if (input.files !== void 0 && input.files.length > 0) {
    lines.push("--- CHANGED/NEW FILES TO READ ---");
    for (const file of input.files) lines.push(`- ${file}`);
  }
  return lines.join("\n");
}
function routeIdentity(route) {
  return [route.provider ?? "", route.model ?? "", route.reasoningEffort ?? "", route.chainId ?? ""].join("/");
}
function hashText(text) {
  if (text === null || text === "") return null;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
async function discoverOracleChild(ctx, parentId) {
  let entries;
  try {
    entries = await ctx.subagents.listChildren(parentId);
  } catch {
    return void 0;
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.mode === "continuable" && entry.label === ORACLE_LABEL) return entry.id;
  }
  return void 0;
}
function resolveOracleTimeoutMs(ctx) {
  try {
    const doc = readOrchestrationDocument(ctx.get("settings"));
    const value = doc?.parameters?.oracle?.timeoutMs;
    if (typeof value === "number" && !Number.isNaN(value)) return Math.min(3e5, Math.max(3e4, value));
  } catch {
  }
  return 12e4;
}
var ORACLE_BRIEF_WAIT_MS = 4e3;
async function ensureBriefWithin(parent, signal) {
  const brief = getBriefService();
  if (brief === null || brief === void 0) return;
  const pending = brief.ensureFreshBrief(parent.session, signal).catch(() => {
    return null;
  });
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ORACLE_BRIEF_WAIT_MS);
  });
  try {
    await Promise.race([pending.then(() => void 0), timeout]);
  } finally {
    if (timer !== void 0) clearTimeout(timer);
  }
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
}
function resolvePersonaModel(ctx, persona) {
  try {
    const doc = readOrchestrationDocument(ctx.get("settings"));
    const key = persona.toLowerCase().replace(/^the\s+/, "").trim();
    const entry = doc?.personas?.[key];
    if (entry && entry.provider && entry.model) {
      return {
        provider: entry.provider,
        model: entry.model,
        ...entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}
      };
    }
  } catch {
  }
  return void 0;
}
function resolveChainSnapshot(ctx, id) {
  if (typeof id !== "string" || id.trim() === "") return void 0;
  try {
    const service = ctx.get("modelChains");
    const snapshot = service?.resolve?.(id.trim());
    if (snapshot === null || typeof snapshot !== "object") return void 0;
    const record = snapshot;
    if (!Array.isArray(record.links)) return void 0;
    const links = [];
    for (const raw of record.links) {
      if (raw === null || typeof raw !== "object") continue;
      const link = raw;
      const provider = typeof link.provider === "string" ? link.provider.trim() : "";
      const model = typeof link.model === "string" ? link.model.trim() : "";
      if (provider === "" || model === "") continue;
      const effort = typeof link.effort === "string" && link.effort.trim() !== "" ? link.effort.trim() : void 0;
      links.push({ provider, model, ...effort !== void 0 ? { effort } : {} });
    }
    if (links.length === 0) return void 0;
    const attempts = typeof record.attempts === "number" && Number.isFinite(record.attempts) && record.attempts >= 1 ? Math.floor(record.attempts) : void 0;
    return {
      id: typeof record.id === "string" && record.id !== "" ? record.id : id.trim(),
      links,
      ...attempts !== void 0 ? { attempts } : {},
      onCut: record.onCut === "continue" ? "continue" : "failover"
    };
  } catch {
    return void 0;
  }
}
function resolveOracleChainAttempts(ctx, persona) {
  try {
    const doc = readOrchestrationDocument(ctx.get("settings"));
    const key = persona.toLowerCase().replace(/^the\s+/, "").trim();
    const entry = doc?.personas?.[key];
    const snapshot = resolveChainSnapshot(ctx, entry?.chain);
    if (snapshot !== void 0) {
      const active = entry != null && entry.provider && entry.model ? {
        provider: entry.provider,
        model: entry.model,
        ...entry.reasoningEffort ? { effort: entry.reasoningEffort } : {}
      } : { ...snapshot.links[0] };
      const links = [
        active,
        ...snapshot.links.filter((link) => !(link.provider === active.provider && link.model === active.model))
      ];
      const head = snapshot.links[0];
      return {
        chainId: snapshot.id,
        carryId: head.provider === active.provider && head.model === active.model,
        attempts: links.map((link) => ({
          provider: link.provider,
          model: link.model,
          ...link.effort !== void 0 ? { reasoningEffort: link.effort } : {}
        }))
      };
    }
  } catch {
  }
  const personaModel = resolvePersonaModel(ctx, persona);
  return {
    carryId: false,
    attempts: personaModel !== void 0 ? [{
      provider: personaModel.provider,
      model: personaModel.model,
      ...personaModel.reasoningEffort !== void 0 ? { reasoningEffort: personaModel.reasoningEffort } : {}
    }] : [{}]
  };
}
function parseVerdict(text) {
  const matches = [...text.matchAll(/\{(?:[^{}]|\{[^{}]*\})*\}/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const candidate = matches[i][0];
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed.approved === "boolean") {
        return {
          approved: parsed.approved,
          concerns: Array.isArray(parsed.concerns) ? parsed.concerns.map(String) : [],
          unverified: Array.isArray(parsed.unverified) ? parsed.unverified.map(String) : [],
          blockers: Array.isArray(parsed.blockers) ? parsed.blockers.map(String) : []
        };
      }
    } catch {
    }
  }
  const approved = /\bapproved\b/i.test(text) && !/not\s+approved|rejected|denied/i.test(text);
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 20);
  const concerns = sentences.filter((s) => /concern|risk|warning|must|should|edge case|careful/i.test(s)).slice(0, 6);
  const blockers = sentences.filter((s) => /blocker|blocked|prevent|fails? closed|cannot|incompatible/i.test(s)).slice(0, 4);
  return { approved, concerns, unverified: [], blockers };
}
function verdictHeadline(turn) {
  if (turn.stopReason !== "completed" && turn.stopReason !== "max-tokens") {
    const detail = turn.error === void 0 ? "" : `: ${turn.error}`;
    return `\u{1F4EC} Oracle consultation ended (${turn.stopReason})${detail}.`;
  }
  const verdict = parseVerdict(turn.text);
  return `\u{1F4EC} Oracle finished \u2014 ${verdict.approved ? "APPROVED" : "CONCERNS"} (${verdict.concerns.length} concern(s)).`;
}
function deliverOracleVerdict(ctx, parentId, capturedHumanSeq, turn) {
  const agent = ctx.get("agents")?.get(parentId);
  if (agent === void 0) return false;
  const message = createUserMessage({
    content: [{ type: "text", text: `${verdictHeadline(turn)}

${turn.text}` }],
    source: { kind: "enpoi-oracle" }
  });
  const currentHumanSeq = lastHumanUserMessageSeq(agent.session.snapshotEvents());
  if (currentHumanSeq !== capturedHumanSeq) agent.send(message, "next-turn", false);
  else if (agent.status === "idle") agent.followup(message);
  else agent.steer(message);
  return true;
}
function apply(ctx, config = {}) {
  const pollMs = Math.max(100, Math.trunc(typeof config.childPollMs === "number" ? config.childPollMs : 1e3));
  ctx.inject(["tools", "subagents", "sessionPersistence", "agents"], (injected) => {
    registerOracleTools(injected, ctx, pollMs);
  });
}
function registerOracleTools(ctx, root, pollMs) {
  ctx = root;
  const children = /* @__PURE__ */ new Map();
  const queue = new ParentFifoQueue();
  ctx.on("session/disposed", (session) => {
    children.delete(session.id);
  });
  ctx.tools.register({
    name: "oracle_review",
    description: [
      "Consult the Oracle (senior reviewer for architecture, conceptual design, planning, trade-offs, code reviews, and debugging).",
      "One persistent Oracle per session remembers every earlier consultation; first call: self-contained context and relevant file paths; later calls: concise deltas.",
      "Calls made while it is busy queue in order.",
      "Blocking by default; background:true delivers the verdict as a message that wakes this session."
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description: "What to review or consult on. First call: self-contained context (concepts, problem, approach, state). Later calls: a concise delta."
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of relevant file paths if reviewing concrete code. Omit for purely conceptual, architectural, or strategic reviews."
        },
        background: {
          type: "boolean",
          description: "Run in the background \u2014 returns immediately; the verdict arrives as a delivered message. Omit for blocking."
        },
        fresh: {
          type: "boolean",
          description: "Start a brand-new Oracle child instead of continuing the persistent one. Use only when the earlier consultation history would mislead."
        }
      },
      required: ["request"]
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          approved: { type: "boolean" },
          concerns: { type: "array", items: { type: "string" } },
          unverified: { type: "array", items: { type: "string" } },
          blockers: { type: "array", items: { type: "string" } },
          summary: { type: "string" },
          background: { type: "boolean" },
          rejected: { type: "boolean" }
        },
        required: ["approved", "concerns", "unverified", "blockers", "summary"]
      },
      render: (_args, value) => {
        if (value.background === true || value.rejected === true) {
          return [{ type: "text", text: value.summary }];
        }
        return [{
          type: "text",
          text: value.approved ? `Oracle verdict: APPROVED${value.concerns.length > 0 ? ` (concerns: ${value.concerns.join("; ")})` : ""}` : `Oracle verdict: CONCERNS${value.concerns.length > 0 ? ` \u2014 ${value.concerns.join("; ")}` : ""}${value.blockers.length > 0 ? ` | blockers: ${value.blockers.join("; ")}` : ""}`
        }];
      }
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent;
      if (parent === void 0) throw new Error("oracle_review requires a calling agent");
      const parentId = parent.session.id;
      const deadline = Date.now() + resolveOracleTimeoutMs(ctx);
      return queue.run(parentId, () => consult(parent, args, exec.signal, deadline, pollMs, children, ctx));
    }
  });
  ctx.tools.register({
    name: "request_evidence",
    description: [
      "Fetch ground truth for one specific question: a research child inspects the codebase (or the web for external targets) and returns a short, cited fact sheet.",
      "Use it whenever first-hand verification would sharpen your work \u2014 ask as many or as few questions as you need, one per call.",
      'The answer carries an exact citation and a confidence level; "NOT FINDABLE" means the research child could not verify it.'
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "Where to look: a module/file/area of the codebase, or a web topic (npm, docs, library, API)." },
        question: { type: "string", description: "The exact factual question to verify." }
      },
      required: ["target", "question"]
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          found: { type: "boolean" },
          citation: { type: "string" },
          facts: { type: "string" },
          confidence: { type: "string" }
        },
        required: ["found", "citation", "facts", "confidence"]
      },
      render: (_args, value) => [{
        type: "text",
        text: value.found ? `FACT SHEET (${value.confidence})
CITATION: ${value.citation}
FACTS: ${value.facts}` : `NOT FINDABLE \u2014 ${value.facts}`
      }]
    },
    async execute(args, exec) {
      const requester = exec.agent;
      if (requester === void 0) throw new Error("request_evidence requires a calling agent");
      const target = String(args.target ?? "").trim();
      const question = String(args.question ?? "").trim();
      if (target.length === 0 || question.length === 0) {
        return { found: false, citation: "n/a", facts: "request_evidence requires both target and question.", confidence: "low" };
      }
      const retrievedBy = isExternalEvidenceTarget(target) ? "librarian" : "explorer";
      const personaModel = resolvePersonaModel(ctx, retrievedBy);
      let childId = null;
      let messageId = null;
      try {
        const started = await ctx.subagents.startContinuable({
          provider: "spawn",
          label: `evidence request: ${question.slice(0, 50)}`,
          quiet: true,
          request: {
            prompt: [{ type: "text", text: `TARGET: ${target}
QUESTION: ${question}

Produce the FACT SHEET now.` }],
            parent: requester,
            persona: EVIDENCE_RESEARCH_PERSONA,
            quiet: true,
            toolFilter: { deny: EVIDENCE_CHILD_DENY },
            ...personaModel !== void 0 ? {
              agentOptions: { provider: personaModel.provider, model: personaModel.model }
            } : {}
          },
          signal: exec.signal
        });
        childId = started.childId;
        messageId = started.messageId;
        const turn = await waitForChildMessageTurn(ctx, childId, messageId, {
          signal: exec.signal,
          deadline: Number.POSITIVE_INFINITY,
          pollMs
        });
        const sheet = parseEvidenceSheet(turn.text);
        if (sheet === null) {
          return { found: false, citation: "n/a", facts: `the research child returned no parseable fact sheet; raw tail: ${turn.text.slice(-300)}`, confidence: "low" };
        }
        const notFindable = /NOT FINDABLE/i.test(sheet.facts);
        return { found: !notFindable, citation: sheet.citation, facts: sheet.facts, confidence: sheet.confidence };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { found: false, citation: "n/a", facts: `evidence retrieval failed: ${message}`, confidence: "low" };
      } finally {
        if (childId !== null) {
          try {
            await ctx.subagents.drainContinuableChildren(requester, [childId]);
          } catch {
          }
        }
      }
    }
  });
}
async function consult(parent, args, signal, deadline, pollMs, children, ctx) {
  const parentId = parent.session.id;
  const events = parent.session.snapshotEvents();
  const lastHumanSeq = lastHumanUserMessageSeq(events);
  const operatorQuery = latestOperatorQuery(events);
  const { chainId, carryId, attempts } = resolveOracleChainAttempts(ctx, "oracle");
  const active = attempts[0] ?? {};
  const route = {
    ...active.provider !== void 0 ? { provider: active.provider } : {},
    ...active.model !== void 0 ? { model: active.model } : {},
    ...active.reasoningEffort !== void 0 ? { reasoningEffort: ReasoningEffortId(active.reasoningEffort) } : {},
    ...carryId && chainId !== void 0 ? { chainId } : {}
  };
  const identity = routeIdentity(route);
  let state = children.get(parentId);
  const routeChanged = state !== void 0 && state.route !== identity;
  if (args.fresh === true) {
    children.delete(parentId);
    state = void 0;
  } else if (routeChanged) {
    children.delete(parentId);
    state = void 0;
  } else if (state === void 0) {
    const rediscovered = await discoverOracleChild(ctx, parentId);
    if (rediscovered !== void 0) {
      state = { childId: rediscovered, route: identity, lastHumanSeq: 0, wbHash: null, briefHash: null };
    }
  }
  const doc = readOrchestrationDocument(ctx.get("settings"));
  const whiteboard = extractWhiteboardSummary(doc, parent.session?.id, parent.session?.header?.cwd);
  const whiteboardHash = hashText(whiteboard);
  const spawn = state === void 0;
  const brief = spawn ? await ensureBriefWithin(parent, signal).then(() => readLivingBrief(ctx, parent.session)) : readLivingBrief(ctx, parent.session);
  const briefHash = hashText(brief);
  const files = Array.isArray(args.files) ? args.files : void 0;
  const newQuery = state !== void 0 && lastHumanSeq !== state.lastHumanSeq;
  const whiteboardChanged = state !== void 0 && whiteboardHash !== state.wbHash;
  const briefChanged = state !== void 0 && newQuery && brief !== null && briefHash !== state.briefHash;
  let content;
  if (spawn || state === void 0) {
    content = [{
      type: "text",
      text: buildInitialPackage({ request: args.request, ...files !== void 0 ? { files } : {}, whiteboard, brief })
    }];
  } else {
    content = [{
      type: "text",
      text: buildDelta({
        request: args.request,
        ...files !== void 0 ? { files } : {},
        operatorQuery: newQuery ? operatorQuery : "",
        whiteboard: whiteboardChanged ? whiteboard : null,
        brief: briefChanged ? brief : null
      })
    }];
  }
  let childId;
  let messageId;
  if (spawn || state === void 0) {
    const agentOptions = active.provider !== void 0 ? {
      provider: active.provider,
      ...active.model !== void 0 ? { model: active.model } : {},
      ...active.reasoningEffort !== void 0 ? { reasoningEffort: ReasoningEffortId(active.reasoningEffort) } : {},
      ...carryId && chainId !== void 0 ? { chain: chainId } : {}
    } : void 0;
    const started = await ctx.subagents.startContinuable({
      provider: "spawn",
      label: ORACLE_LABEL,
      quiet: true,
      request: {
        prompt: content,
        parent,
        persona: ORACLE_PERSONA,
        quiet: true,
        toolFilter: { deny: ORACLE_TOOL_FILTER.deny },
        ...agentOptions !== void 0 ? { agentOptions } : {}
      },
      signal
    });
    childId = started.childId;
    messageId = started.messageId;
    children.set(parentId, { childId, route: identity, lastHumanSeq, wbHash: whiteboardHash, briefHash });
  } else {
    const current = state;
    childId = current.childId;
    messageId = await queueHostSubagentPrompt2(ctx.subagents, parent, childId, content, { kind: "user" }, signal);
    children.set(parentId, {
      ...current,
      lastHumanSeq,
      wbHash: whiteboardChanged ? whiteboardHash : current.wbHash,
      briefHash: briefChanged ? briefHash : current.briefHash
    });
  }
  if (args.background === true) {
    void (async () => {
      try {
        const turn = await waitForChildMessageTurn(ctx, childId, messageId, {
          signal: new AbortController().signal,
          deadline: Number.POSITIVE_INFINITY,
          pollMs
        });
        deliverOracleVerdict(ctx, parentId, lastHumanSeq, turn);
      } catch {
      }
    })();
    return {
      approved: false,
      concerns: [],
      unverified: [],
      blockers: [],
      summary: `Background consultation started (${childId}) \u2014 the verdict will be delivered as a message when the oracle finishes.`,
      background: true
    };
  }
  try {
    const turn = await waitForChildMessageTurn(ctx, childId, messageId, { signal, deadline, pollMs });
    if (turn.stopReason === "error" || turn.stopReason === "aborted" || turn.stopReason === "refusal") {
      const detail = turn.error ?? `turn ended ${turn.stopReason}`;
      return {
        approved: false,
        concerns: [`Oracle consultation failed: ${detail}`],
        unverified: [],
        blockers: [`ORACLE_MODEL_ERROR: ${detail}`],
        summary: `Oracle consultation failed: ${detail}`,
        rejected: true
      };
    }
    const verdict = parseVerdict(turn.text);
    return {
      approved: verdict.approved,
      concerns: verdict.concerns,
      unverified: verdict.unverified,
      blockers: verdict.blockers,
      summary: turn.text
    };
  } catch (error) {
    if (error instanceof ChildTurnTimeoutError) {
      void (async () => {
        try {
          const turn = await waitForChildMessageTurn(ctx, error.childId, error.messageId, {
            signal: new AbortController().signal,
            deadline: Number.POSITIVE_INFINITY,
            pollMs
          });
          deliverOracleVerdict(ctx, parentId, lastHumanSeq, turn);
        } catch {
        }
      })();
      return {
        approved: false,
        concerns: [],
        unverified: [],
        blockers: ["ORACLE_PENDING"],
        summary: `ORACLE_PENDING: the Oracle is still working on ${error.childId}; the verdict will be delivered as a message.`,
        rejected: true
      };
    }
    if (signal.aborted) {
      ctx.subagents.interrupt(childId, { kind: "ancestor", agent: parent });
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      approved: false,
      concerns: [`Oracle consultation failed: ${message}`],
      unverified: [],
      blockers: [`ORACLE_MODEL_ERROR: ${message}`],
      summary: `Oracle consultation failed: ${message}`,
      rejected: true
    };
  }
}
var EVIDENCE_CHILD_DENY = [
  "send_message",
  "oracle_review",
  "request_evidence",
  "dispatch_task",
  "subagent",
  "subagent_fork",
  "subagent_codex",
  "subagent_claude_code",
  "roundtable",
  "chorus",
  "council_register",
  "bash",
  "edit",
  "write",
  "str_replace_editor",
  "todo_write",
  "plan_mode",
  "goal",
  "create_goal",
  "get_goal",
  "update_goal",
  "exit_plan_mode",
  "workflow",
  "ralph",
  "job_output",
  "job_list",
  "job_kill",
  "skill",
  "ask_user_question",
  "memory_save",
  "memory_search",
  "memory_rescind",
  "memory_confirm",
  "interrupt_agent",
  "list_agents",
  // Harness authoring (seat guard) and reviewer-exec (the research child is not
  // a reviewer seat): refused at execution, so absent from the catalog.
  "plugin_manager",
  "cordis_inspect_list",
  "cordis_inspect_query",
  "review_run"
];
export {
  ChildTurnTimeoutError,
  Config,
  EVIDENCE_CHILD_DENY,
  ORACLE_LABEL,
  ORACLE_PERSONA,
  ORACLE_TOOL_FILTER,
  ParentFifoQueue,
  apply,
  askChild,
  buildDelta,
  buildInitialPackage,
  deliverOracleVerdict,
  discoverOracleChild,
  extractWhiteboardSummary,
  hashText,
  inject,
  isExternalEvidenceTarget,
  lastHumanUserMessageSeq,
  name,
  parseEvidenceSheet,
  resolveOracleChainAttempts,
  resolveOracleTimeoutMs,
  resolvePersonaModel,
  routeIdentity,
  textOfContent,
  waitForChildMessageTurn
};
