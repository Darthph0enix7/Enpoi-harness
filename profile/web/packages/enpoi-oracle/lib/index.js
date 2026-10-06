// src/index.ts
import { queueHostSubagentPrompt } from "@deepseek-ai/dsh-subagent/internal";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { getBriefService } from "dsh-enpoi-context-keeper";
import { readOrchestrationDocument } from "dsh-enpoi-contracts";
var name = "enpoi-oracle";
var inject = ["tools", "subagents", "sessionPersistence", "sessions", "agents"];
var ORACLE_PERSONA = [
  "You are the Oracle \u2014 senior architectural supervisor, conceptual thinker, and deep reviewer.",
  "You reason independently and deeply: you evaluate architecture, concepts, system trade-offs, logic, race conditions, and code.",
  "You are an advisor, not a dictator: if a plan is flawed, over-engineered, or heading in the wrong direction, say so plainly.",
  "When reviewing code, inspect relevant files directly using your search/read tools as needed to understand the broader context. When reviewing concepts or plans, evaluate feasibility, modularity, and trade-offs.",
  "This is a continuing reviewer session within the active query: reuse your accumulated context and memory from prior turns.",
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
    const e = events[i];
    if (e?.type === "user/message") {
      const src = e.data?.source;
      if (src?.kind === "user") return e.seq;
    }
  }
  return 0;
}
function textOfContent(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks.map((block) => {
    if (typeof block !== "object" || block === null || !("text" in block)) return "";
    const blockType = block.type;
    return blockType === "text" || blockType === void 0 ? String(block.text) : "";
  }).filter((text) => text.length > 0).join(" ");
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
    ].filter((p) => p !== null);
    return parts.length > 0 ? parts.join("\n") : null;
  } catch {
    return null;
  }
}
function buildInitialPackage(brief, args, scorecard) {
  const lines = [];
  lines.push("You are the Oracle \u2014 the senior architectural supervisor and deep reviewer.");
  lines.push("This is a FRESH consultation session for the active user query. Review the request below against the current state.");
  if (brief !== null) {
    lines.push("--- SESSION BRIEF ---");
    lines.push(brief);
  }
  if (scorecard.verdicts.length > 0) {
    lines.push("--- PRIOR REVIEWS IN RECENT SESSIONS (condensed scorecard) ---");
    for (const v of scorecard.verdicts.slice(-3)) {
      lines.push(`- ${v.approved ? "approved" : "concerns"}: ${v.concerns.join("; ") || "no concerns noted"}`);
    }
  }
  lines.push("--- REVIEW REQUEST ---");
  lines.push(args.request);
  if (Array.isArray(args.files) && args.files.length > 0) {
    lines.push("--- READING LIST (read these files directly) ---");
    for (const f of args.files) lines.push(`- ${f}`);
  }
  return lines.join("\n");
}
function buildDelta(brief, args) {
  const lines = ["Follow-up review in the SAME query (delta turn). Your prior review and findings are in your conversation history above."];
  if (brief !== null) {
    lines.push("--- CURRENT SESSION BRIEF ---", brief);
  }
  lines.push("--- DELTA REQUEST ---", args.request);
  if (Array.isArray(args.files) && args.files.length > 0) {
    lines.push("--- CHANGED/NEW FILES TO READ ---");
    for (const f of args.files) lines.push(`- ${f}`);
  }
  return lines.join("\n");
}
var ORACLE_BRIEF_WAIT_MS = 4e3;
async function ensureBriefWithin(parent, signal) {
  const brief = getBriefService();
  if (brief === void 0) return;
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
function resolveOracleTimeoutMs(ctx) {
  try {
    const doc = readOrchestrationDocument(ctx.get("settings"));
    const v = doc?.parameters?.oracle?.timeoutMs;
    if (typeof v === "number" && !Number.isNaN(v)) return Math.min(3e5, Math.max(3e4, v));
  } catch {
  }
  return 12e4;
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
      const active = entry != null && entry.provider && entry.model ? { provider: entry.provider, model: entry.model } : { ...snapshot.links[0] };
      const links = [
        active,
        ...snapshot.links.filter((link) => !(link.provider === active.provider && link.model === active.model))
      ];
      const head = snapshot.links[0];
      return {
        chainId: snapshot.id,
        carryId: head.provider === active.provider && head.model === active.model,
        attempts: links.map((link) => ({ provider: link.provider, model: link.model }))
      };
    }
  } catch {
  }
  const personaModel = resolvePersonaModel(ctx, persona);
  return {
    carryId: false,
    attempts: personaModel !== void 0 ? [{ provider: personaModel.provider, model: personaModel.model }] : [{}]
  };
}
function applyPersonaModel(ctx, childId, persona) {
  try {
    const entry = resolvePersonaModel(ctx, persona);
    if (entry && entry.provider && entry.model) {
      const sessions = ctx.get("sessions");
      const childSession = sessions?.get?.(childId);
      if (childSession && typeof childSession.append === "function") {
        childSession.append("request/header", {
          header: {
            config: {
              provider: entry.provider,
              model: entry.model,
              ...entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}
            }
          },
          reason: "custom"
        });
      }
    }
  } catch {
  }
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
var OracleTimeoutError = class extends Error {
  /**
   * @param childId - the still-running oracle child the wait abandoned.
   * @param timeoutMs - the exceeded wait budget.
   */
  constructor(childId, timeoutMs) {
    super(`oracle consultation timed out after ${timeoutMs}ms`);
    this.childId = childId;
    this.timeoutMs = timeoutMs;
    this.name = "OracleTimeoutError";
  }
};
async function waitForChildTurn(ctx, childId, signal, timeoutMs = 12e4, pollMs = 100) {
  const started = Date.now();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (; ; ) {
      if (signal.aborted) throw new Error("oracle consultation aborted");
      if (Date.now() - started > timeoutMs) throw new OracleTimeoutError(childId, timeoutMs);
      if (ctx.agents.get(childId) === void 0) {
        const persistence = ctx.get("sessionPersistence");
        if (persistence !== void 0) {
          const handle = await persistence.open(childId, "read");
          let events;
          try {
            events = (await handle.read(0, void 0)).events;
          } finally {
            await handle.close();
          }
          const lastUser = [...events].reverse().find((e) => e.type === "user/message");
          const since = lastUser === void 0 ? 0 : lastUser.seq;
          const messages = events.filter((e) => e.type === "assistant/message" && e.seq > since);
          if (messages.length > 0) {
            const extracted = messages.map((m) => {
              const data = m.data;
              return textOfContent(data.message?.content ?? data.content);
            }).filter((t) => t.length > 0).join("\n").trim();
            if (extracted.length > 0) {
              return extracted;
            }
          }
          const turnEnd = events.find((e) => e.type === "turn/end" && e.seq > since);
          if (turnEnd !== void 0) {
            const reason = turnEnd.data?.reason;
            if (reason?.kind === "error") {
              const errMsg = reason.error?.message ?? reason.failure?.message ?? "Model execution failed";
              throw new Error(`Turn failed: ${errMsg}`);
            }
            if (reason?.kind === "aborted") {
              const abortCause = reason.reason?.kind ?? "cancelled";
              throw new Error(`Turn was aborted (${abortCause})`);
            }
            if (reason?.kind === "completed" && messages.length === 0) {
              return "[NO_OUTPUT: oracle returned empty content]";
            }
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
async function deliverDetachedOracleVerdict(options) {
  const { ctx, parent, childId, fiber, key, busy } = options;
  try {
    const text = await waitForChildTurn(
      ctx,
      childId,
      new AbortController().signal,
      Number.POSITIVE_INFINITY,
      options.pollMs ?? 1e3
    );
    const verdict = parseVerdict(text);
    fiber.consultations += 1;
    fiber.scorecard.verdicts.push({ approved: verdict.approved, concerns: verdict.concerns });
    const agent = ctx.get("agents")?.get(parent.session.id);
    if (agent !== void 0) {
      agent.inject(createUserMessage({
        content: [{
          type: "text",
          text: `\u{1F4EC} Oracle (detached after timeout) finished \u2014 ${verdict.approved ? "APPROVED" : "CONCERNS"} (${verdict.concerns.length} concern(s)).

${text}`
        }],
        source: { kind: "enpoi-oracle" }
      }));
    }
  } catch {
  } finally {
    busy.delete(key);
  }
}
function apply(ctx) {
  ctx.inject(["tools", "subagents", "sessionPersistence", "sessions"], (injected) => {
    registerOracleTools(injected, ctx);
  });
}
function registerOracleTools(ctx, root) {
  ctx = root;
  const fibers = /* @__PURE__ */ new Map();
  const rolloverScorecards = /* @__PURE__ */ new Map();
  const busy = /* @__PURE__ */ new Set();
  ctx.tools.register({
    name: "oracle_review",
    description: [
      "Consult the Oracle (senior reviewer for architecture, conceptual design, planning, trade-offs, code reviews, and debugging).",
      "The Oracle reasons independently about concepts and code. LIFECYCLE: Starts fresh on each new user query, but stays persistent across follow-up calls within that query.",
      "Call #1 of a query: provide self-contained context (what you are building/fixing, architecture, decisions) and any relevant file paths if applicable. On follow-ups: send concise deltas.",
      "Blocking by default; background:true delivers verdict as a message."
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description: "What to review or consult on. On Call #1 of a query, provide clear self-contained context (concepts, problem, approach, state). On follow-ups in the same query, provide a concise delta."
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of relevant file paths if reviewing concrete code. Omit for purely conceptual, architectural, or strategic reviews."
        },
        background: {
          type: "boolean",
          description: "Run in the background \u2014 returns immediately; the verdict arrives as a delivered message. Omit for blocking."
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
      const key = parent.session.id;
      if (busy.has(key)) {
        return {
          approved: false,
          concerns: [],
          unverified: [],
          blockers: ["CONCURRENT_CALL_REJECTED: another oracle consultation is already running for this session"],
          summary: "Rejected by the single-flight mutex (I7): another oracle consultation is already running for this session.",
          rejected: true
        };
      }
      busy.add(key);
      let bg = null;
      let stopWatch = null;
      let handedOff = false;
      try {
        const lastUserSeq = lastHumanUserMessageSeq(parent.session.snapshotEvents());
        let fiber = fibers.get(key);
        let rolloverScorecard = null;
        if (fiber !== void 0 && (fiber.lastParentUserSeq !== lastUserSeq || fiber.childId === null)) {
          rolloverScorecard = fiber.scorecard;
          fibers.delete(key);
          fiber = void 0;
        } else if (fiber === void 0 && rolloverScorecards.has(key)) {
          rolloverScorecard = rolloverScorecards.get(key);
        }
        const fresh = fiber === void 0;
        if (fresh) {
          await ensureBriefWithin(parent, exec.signal);
          fiber = {
            childId: null,
            consultations: 0,
            lastParentUserSeq: lastUserSeq,
            scorecard: rolloverScorecard ?? { files: [], verdicts: [] },
            brief: readLivingBrief(ctx, parent.session)
          };
        }
        const brief = fiber.brief;
        if (args.background === true) {
          bg = new AbortController();
          stopWatch = ctx.on("session/event", (s, e) => {
            if (s.id !== parent.session.id) return;
            if (e.type === "turn/end" && e.data.reason.kind === "aborted" && e.data.reason.reason?.kind === "user") bg?.abort();
          });
        }
        const prompt = [{
          type: "text",
          text: fresh ? buildInitialPackage(brief, args, fiber.scorecard) : buildDelta(brief, args)
        }];
        const { chainId, carryId, attempts: attemptModels } = resolveOracleChainAttempts(ctx, "oracle");
        const callSignal = () => bg?.signal ?? exec.signal;
        const spawnOracleChild = async (attempt, carriedChainId) => {
          const denied = ORACLE_TOOL_FILTER.deny;
          const started = await ctx.subagents.startContinuable({
            provider: "spawn",
            label: `oracle review: ${args.request.slice(0, 60)}`,
            quiet: true,
            request: {
              prompt,
              parent,
              persona: ORACLE_PERSONA,
              quiet: true,
              toolFilter: denied.length > 0 ? { deny: denied } : void 0,
              ...attempt.provider !== void 0 ? {
                agentOptions: {
                  provider: attempt.provider,
                  model: attempt.model,
                  ...carriedChainId !== void 0 ? { chain: carriedChainId } : {}
                }
              } : {}
            },
            signal: callSignal()
          });
          if (!started.childId || started.childId === "null" || !started.childId.includes("-")) {
            throw new Error(`oracle spawn returned an invalid child id: ${String(started.childId)}`);
          }
          return started.childId;
        };
        const waitWithChainAdvance = async (firstChildId, advance) => {
          let childId = firstChildId;
          let lastError;
          for (let index = 0; index < attemptModels.length; index += 1) {
            try {
              return await waitForChildTurn(ctx, childId, callSignal(), resolveOracleTimeoutMs(ctx));
            } catch (error) {
              lastError = error;
              if (callSignal().aborted) throw error;
              if (error instanceof OracleTimeoutError) throw error;
              const current = attemptModels[index];
              const next = advance ? attemptModels[index + 1] : void 0;
              if (next === void 0) break;
              const message = error instanceof Error ? error.message : String(error);
              process.stderr.write(`[model-chain] ${chainId ?? "oracle"}: link ${index + 1} (${current.provider ?? "default"}/${current.model ?? "default"}) FAILED \u2192 link ${index + 2} (${next.provider ?? "default"}/${next.model ?? "default"}): ${message}
`);
              try {
                await ctx.get("sessions")?.delete(childId);
              } catch {
              }
              childId = await spawnOracleChild(next, chainId);
              fiber.childId = childId;
              fibers.set(key, fiber);
            }
          }
          throw lastError instanceof Error ? lastError : new Error(String(lastError));
        };
        if (fresh) {
          try {
            const childId = await spawnOracleChild(attemptModels[0], carryId ? chainId : void 0);
            fiber.childId = childId;
            applyPersonaModel(ctx, childId, "oracle");
            fibers.set(key, fiber);
            if (rolloverScorecard !== null && rolloverScorecards.has(key)) {
              rolloverScorecards.delete(key);
            }
          } catch (err) {
            fibers.delete(key);
            throw err;
          }
        } else {
          await queueHostSubagentPrompt(
            ctx.subagents,
            parent,
            fiber.childId,
            prompt,
            { kind: "user" },
            bg?.signal ?? exec.signal
          );
        }
        if (bg !== null) {
          handedOff = true;
          const childId = fiber.childId;
          void (async () => {
            try {
              let t;
              try {
                t = await waitWithChainAdvance(childId, fresh);
              } catch (error) {
                if (!(error instanceof OracleTimeoutError)) throw error;
                t = await waitForChildTurn(ctx, error.childId, new AbortController().signal, Number.POSITIVE_INFINITY, 1e3);
              }
              const v = parseVerdict(t);
              fiber.consultations += 1;
              fiber.scorecard.verdicts.push({ approved: v.approved, concerns: v.concerns });
              if (Array.isArray(args.files)) fiber.scorecard.files.push(...args.files);
              if (fiber.consultations >= 10) {
                rolloverScorecards.set(key, fiber.scorecard);
                fibers.delete(key);
              }
              const agent = ctx.get("agents")?.get(parent.session.id);
              if (agent !== void 0) {
                agent.inject(createUserMessage({
                  content: [{
                    type: "text",
                    text: `\u{1F4EC} Oracle (background) finished \u2014 ${v.approved ? "APPROVED" : "CONCERNS"} (${v.concerns.length} concern(s)).

${t}`
                  }],
                  source: { kind: "enpoi-oracle" }
                }));
              }
            } catch {
            } finally {
              stopWatch?.();
              busy.delete(key);
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
        let verdictText = "";
        try {
          verdictText = await waitWithChainAdvance(fiber.childId, fresh);
        } catch (err) {
          if (err instanceof OracleTimeoutError) {
            handedOff = true;
            void deliverDetachedOracleVerdict({ ctx, parent, childId: err.childId, fiber, key, busy });
            return {
              approved: false,
              concerns: [`Oracle consultation timed out after ${err.timeoutMs}ms; the oracle child is still running.`],
              unverified: [],
              blockers: [`ORACLE_TIMEOUT_DETACHED: oracle child ${err.childId} was NOT cancelled \u2014 its verdict will be delivered as a message when it finishes.`],
              summary: `Oracle consultation timed out after ${err.timeoutMs}ms. The oracle child ${err.childId} was NOT cancelled and is still working; its verdict will be delivered as a message when it finishes.`,
              rejected: true
            };
          }
          const errMsg = err instanceof Error ? err.message : String(err);
          fibers.delete(key);
          return {
            approved: false,
            concerns: [`Oracle consultation failed: ${errMsg}`],
            unverified: [],
            blockers: [`ORACLE_MODEL_ERROR: ${errMsg}`],
            summary: `Oracle consultation failed: ${errMsg}`,
            rejected: true
          };
        }
        const verdict = parseVerdict(verdictText);
        fiber.consultations += 1;
        fiber.scorecard.verdicts.push({ approved: verdict.approved, concerns: verdict.concerns });
        if (Array.isArray(args.files)) fiber.scorecard.files.push(...args.files);
        if (fiber.consultations >= 10) {
          rolloverScorecards.set(key, fiber.scorecard);
          fibers.delete(key);
        }
        return {
          approved: verdict.approved,
          concerns: verdict.concerns,
          unverified: verdict.unverified,
          blockers: verdict.blockers,
          summary: verdictText
        };
      } finally {
        if (!handedOff) {
          stopWatch?.();
          busy.delete(key);
        }
      }
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
        if (!started.childId || started.childId === "null" || !String(started.childId).includes("-")) {
          throw new Error(`evidence research child spawn returned an invalid id: ${String(started.childId)}`);
        }
        childId = started.childId;
        const text = await waitForChildTurn(ctx, childId, exec.signal, 24e4);
        const sheet = parseEvidenceSheet(text);
        if (sheet === null) {
          return { found: false, citation: "n/a", facts: `the research child returned no parseable fact sheet; raw tail: ${text.slice(-300)}`, confidence: "low" };
        }
        const notFindable = /NOT FINDABLE/i.test(sheet.facts);
        return { found: !notFindable, citation: sheet.citation, facts: sheet.facts, confidence: sheet.confidence };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { found: false, citation: "n/a", facts: `evidence retrieval failed: ${msg}`, confidence: "low" };
      } finally {
        if (childId !== null) {
          try {
            await ctx.get("sessions")?.delete(childId);
          } catch {
          }
        }
      }
    }
  });
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
  EVIDENCE_CHILD_DENY,
  ORACLE_TOOL_FILTER,
  OracleTimeoutError,
  apply,
  buildInitialPackage,
  deliverDetachedOracleVerdict,
  inject,
  isExternalEvidenceTarget,
  name,
  parseEvidenceSheet,
  resolveOracleChainAttempts,
  resolveOracleTimeoutMs,
  resolvePersonaModel,
  textOfContent,
  waitForChildTurn
};
