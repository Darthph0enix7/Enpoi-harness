var __knownSymbol = (name2, symbol) => (symbol = Symbol[name2]) ? symbol : Symbol.for("Symbol." + name2);
var __typeError = (msg) => {
  throw TypeError(msg);
};
var __using = (stack, value2, async) => {
  if (value2 != null) {
    if (typeof value2 !== "object" && typeof value2 !== "function") __typeError("Object expected");
    var dispose, inner;
    if (async) dispose = value2[__knownSymbol("asyncDispose")];
    if (dispose === void 0) {
      dispose = value2[__knownSymbol("dispose")];
      if (async) inner = dispose;
    }
    if (typeof dispose !== "function") __typeError("Object not disposable");
    if (inner) dispose = function() {
      try {
        inner.call(this);
      } catch (e) {
        return Promise.reject(e);
      }
    };
    stack.push([async, dispose, value2]);
  } else if (async) {
    stack.push([async]);
  }
  return value2;
};
var __callDispose = (stack, error, hasError) => {
  var E = typeof SuppressedError === "function" ? SuppressedError : function(e, s, m, _) {
    return _ = Error(m), _.name = "SuppressedError", _.error = e, _.suppressed = s, _;
  };
  var fail = (e) => error = hasError ? new E(e, error, "An error was suppressed during disposal") : (hasError = true, e);
  var next = (it) => {
    while (it = stack.pop()) {
      try {
        var result = it[1] && it[1].call(it[2]);
        if (it[0]) return Promise.resolve(result).then(next, (e) => (fail(e), next()));
      } catch (e) {
        fail(e);
      }
    }
    if (hasError) throw error;
  };
  return next();
};

// src/index.ts
import { SessionLogOffset } from "@deepseek-ai/dsh-session";
import { BlockAssembler, createUserMessage, isContextWindowExceededError } from "@deepseek-ai/dsh-llm";
import { deadline } from "@deepseek-ai/dsh-timeout";
import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { openMemoryDb } from "dsh-enpoi-memory";
import { makePipeline } from "dsh-enpoi-memory";
import { readOrchestrationDocument } from "dsh-enpoi-contracts";
import { join } from "node:path";
import Schema from "@deepseek-ai/schemastery";
var name = "enpoi-context-keeper";
function live(schema) {
  return schema.volatile?.() ?? schema;
}
function value(field) {
  return typeof field?.get === "function" ? field.get() : field;
}
function plainConfig(config) {
  const out = {};
  for (const [key, field] of Object.entries(config)) out[key] = value(field);
  return out;
}
var inject = ["llm"];
function diag(line) {
  try {
    const home = process.env.DSH_HOME ?? (process.env.VITEST === "true" ? join(tmpdir(), "dsh-keeper-vitest") : process.env.HOME ?? "/tmp");
    const dir = join(home.endsWith(".dsh") ? home : join(home, ".dsh"), "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "enpoi-keeper.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${line}
`);
  } catch {
  }
}
function keeperEnabled(ctx) {
  try {
    const doc = readOrchestrationDocument(ctx.get("settings"));
    const tools = doc?.capabilities?.tools;
    return tools?.["keeper"] !== false;
  } catch {
    return true;
  }
}
var Config = Schema.object({
  provider: live(Schema.string().default("kilo")),
  model: live(Schema.string().default("kilo-auto/free")),
  fallbackProvider: live(Schema.string()),
  fallbackModel: live(Schema.string()),
  leaseMs: live(Schema.number().default(45e3)),
  maxInputEvents: live(Schema.number().default(80)),
  maxOutputTokens: live(Schema.number().default(2048)),
  structuralDistanceK: live(Schema.number().default(24)),
  minRefreshMs: live(Schema.number().default(6e4)),
  negativeCacheMs: live(Schema.number().default(12e4)),
  claimsBatchSize: live(Schema.number().default(8)),
  claimsBatchMinutes: live(Schema.number().default(5)),
  checkpointStaleEvents: live(Schema.number().default(12)),
  checkpointStaleHours: live(Schema.number().default(24))
});
var PROSE_PROMPT = [
  "You are the Enpoi Harness context keeper \u2014 the master background summarizer and architectural keeper for this coding session.",
  "You maintain a running, concise, and highly accurate Living Brief of the session for later dispatch to the Oracle and Council debaters.",
  "If a [PREVIOUS SESSION BRIEF] is provided, incrementally merge it with the [RECENT SESSION EVENTS & TOOL RESULTS] (including Council/Roundtable consensus, Oracle verdicts, subagent returns, tool results, documentation paths, and user directives).",
  "NEVER extract, repeat, or retain credentials, passwords, API keys, tokens, or personal secrets.",
  "",
  "CRITICAL SECTION DISCIPLINE (ZERO-FILLER RULE):",
  "- ONLY include a section if there is genuine, substantive information established in the session.",
  '- If no documentation files were created or referenced, DO NOT emit the \u{1F4DA} section and NEVER write "No documentation...".',
  '- If no approaches were debated/rejected, DO NOT emit the \u{1F6AB} section and NEVER write "No alternative approaches...".',
  '- If there are no open blockers, DO NOT emit the \u26A1 section and NEVER write "No blockers remain...".',
  "- For simple queries, greetings, or health-checks (e.g. ping), emit ONLY a single-line \u{1F3AF} ACTIVE GOAL or keep the brief empty. NEVER invent placeholder bullets.",
  "",
  "Output ONLY the relevant section headers from below (omit any section with no substantive content):",
  "",
  "\u{1F3AF} ACTIVE GOAL & CORE TRAJECTORY:",
  "- Current active objective, user directives, and high-level technical paradigms.",
  "",
  "\u{1F4DA} DOCUMENTATION & SPECIFICATIONS INVENTORY:",
  "- List documentation, plans, architectures, and spec files written, modified, or referenced in the session with a 1-line summary.",
  "",
  "\u{1F3DB}\uFE0F ARCHITECTURAL INVARIANTS & CONCRETE DECISIONS:",
  "- Concrete technical decisions established in the session: exact component boundaries, protocols (IPC/HTTP/WS/Redis), data keys/schemas, state machines, and concurrency rules.",
  "",
  "\u{1F6AB} REJECTED APPROACHES & EDGE CASES:",
  "- Approaches debated and explicitly ruled out (and reasons why), edge cases handled, and failure modes defended.",
  "",
  "\u26A1 ACTIVE BLOCKERS & OPEN QUESTIONS:",
  "- Unresolved technical questions, pending implementation tasks, or immediate next steps.",
  "",
  "No other text at all \u2014 no preamble, no CLAIMS block, no JSON."
].join("\n");
var CLAIMS_PROMPT = [
  "You are the Enpoi Harness memory extractor. From the [RECENT SESSION EVENTS & TOOL RESULTS] below, extract durable, permanent facts about operator's environment, infrastructure, and architecture.",
  "NEVER extract, repeat, or retain credentials, passwords, API keys, tokens, or personal secrets.",
  "",
  'Output EXACTLY one line: "CLAIMS:" followed by a JSON array: [{"fact":"...","category":"ARCHITECTURE","tags":"...","source":"tool"}]',
  "- category limited to ARCHITECTURE, CONFIG_VALUES, or PROJECT.",
  '- source MUST be "tool" when the fact is derived from tool results/executions (verified by execution), or "chat" when it was stated by the user or assistant in conversation.',
  '- File 2-4 durable facts whenever the session surfaces them; else "CLAIMS: []".',
  "- Skip transient chatter and anything already obvious from the session itself.",
  "No other text at all."
].join("\n");
var STRUCTURAL_TYPES = /* @__PURE__ */ new Set(["user/message", "turn/end", "tool/call", "tool/result"]);
var KEEPER_MAX_OUTPUT_TOKENS = 4096;
var structuralCounters = /* @__PURE__ */ new WeakMap();
function structuralTotal(session) {
  const known = structuralCounters.get(session);
  if (known === void 0) {
    let count2 = 0;
    for (const event of session.snapshotEvents()) {
      if (STRUCTURAL_TYPES.has(event.type)) count2 += 1;
    }
    structuralCounters.set(session, { seq: session.seq, total: count2 });
    return count2;
  }
  if (session.seq <= known.seq) return known.total;
  let count = known.total;
  for (const event of session.snapshotEvents(SessionLogOffset(known.seq))) {
    if (STRUCTURAL_TYPES.has(event.type)) count += 1;
  }
  structuralCounters.set(session, { seq: session.seq, total: count });
  return count;
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
    const onCut = record.onCut === "continue" ? "continue" : "failover";
    return {
      id: typeof record.id === "string" && record.id !== "" ? record.id : id.trim(),
      links,
      ...attempts !== void 0 ? { attempts } : {},
      onCut
    };
  } catch {
    return void 0;
  }
}
function resolveKeeperParams(ctx, config) {
  config = plainConfig(config);
  try {
    const doc = readOrchestrationDocument(ctx.get("settings"));
    const p = doc?.parameters?.keeper;
    if (p === void 0 || typeof p !== "object") return config;
    const clamp = (v, fallback, min, max) => typeof v === "number" && !Number.isNaN(v) ? Math.min(max, Math.max(min, v)) : fallback;
    return {
      ...config,
      leaseMs: clamp(p.leaseMs, config.leaseMs ?? 45e3, 15e3, 12e4),
      maxInputEvents: clamp(p.maxInputEvents, config.maxInputEvents ?? 80, 20, 200),
      maxOutputTokens: clamp(p.maxOutputTokens, config.maxOutputTokens ?? 2048, 512, KEEPER_MAX_OUTPUT_TOKENS),
      structuralDistanceK: clamp(p.structuralDistanceK, config.structuralDistanceK ?? 24, 4, 200),
      minRefreshMs: clamp(p.minRefreshMs, config.minRefreshMs ?? 6e4, 5e3, 3e5),
      negativeCacheMs: clamp(p.negativeCacheMs, config.negativeCacheMs ?? 12e4, 5e3, 6e5),
      claimsBatchSize: clamp(p.claimsBatchSize, config.claimsBatchSize ?? 8, 1, 50),
      claimsBatchMinutes: clamp(p.claimsBatchMinutes, config.claimsBatchMinutes ?? 5, 1, 60),
      checkpointStaleEvents: clamp(p.checkpointStaleEvents, config.checkpointStaleEvents ?? 12, 1, 500),
      checkpointStaleHours: clamp(p.checkpointStaleHours, config.checkpointStaleHours ?? 24, 1, 168)
    };
  } catch {
    return config;
  }
}
function resolveKeeperRoute(ctx, config) {
  config = plainConfig(config);
  const fallback = config.fallbackProvider !== void 0 && config.fallbackModel !== void 0 ? { fallbackProvider: config.fallbackProvider, fallbackModel: config.fallbackModel } : {};
  try {
    const doc = readOrchestrationDocument(ctx.get("settings"));
    const entry = doc?.personas?.["keeper"];
    const chain = resolveChainSnapshot(ctx, entry?.chain);
    if (chain !== void 0) {
      const active = entry !== void 0 && entry.provider && entry.model ? {
        provider: entry.provider,
        model: entry.model,
        ...entry.reasoningEffort ? { effort: entry.reasoningEffort } : {}
      } : { ...chain.links[0] };
      const links = [
        active,
        ...chain.links.filter((link) => !(link.provider === active.provider && link.model === active.model))
      ];
      return {
        provider: active.provider,
        model: active.model,
        ...fallback,
        ...active.effort ? { reasoningEffort: active.effort } : {},
        chainId: chain.id,
        chainLinks: links
      };
    }
    if (entry && entry.provider && entry.model) {
      return {
        provider: entry.provider,
        model: entry.model,
        ...fallback,
        ...entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}
      };
    }
  } catch {
  }
  return {
    provider: config.provider ?? "kilo",
    model: config.model ?? "kilo-auto/free",
    ...fallback
  };
}
function keeperAttempts(route) {
  if (route.chainLinks !== void 0 && route.chainLinks.length > 0) {
    return route.chainLinks.map((link) => ({
      provider: link.provider,
      model: link.model,
      ...link.effort !== void 0 ? { reasoningEffort: link.effort } : {}
    }));
  }
  const attempts = [
    {
      provider: route.provider,
      model: route.model,
      ...route.reasoningEffort !== void 0 ? { reasoningEffort: route.reasoningEffort } : {}
    }
  ];
  if (route.fallbackProvider !== void 0 && route.fallbackModel !== void 0) {
    attempts.push({
      provider: route.fallbackProvider,
      model: route.fallbackModel,
      ...route.reasoningEffort !== void 0 ? { reasoningEffort: route.reasoningEffort } : {}
    });
  }
  return attempts;
}
var KEEPER_CACHE_CAP = 128;
var BoundedSessionCache = class extends Map {
  /**
   * @param cap - maximum live entries (LRU).
   * @param onEvict - optional cleanup for a value the LRU evicts (e.g. a
   *   pending timer). Never called by explicit `delete`/`clear` — callers that
   *   drop an entry deliberately own its teardown.
   */
  constructor(cap = KEEPER_CACHE_CAP, onEvict) {
    super();
    this.onEvict = onEvict;
    this.cap = Number.isFinite(cap) ? Math.max(1, Math.floor(cap)) : KEEPER_CACHE_CAP;
  }
  cap;
  get(key) {
    const value2 = super.get(key);
    if (value2 !== void 0) {
      super.delete(key);
      super.set(key, value2);
    }
    return value2;
  }
  set(key, value2) {
    super.delete(key);
    super.set(key, value2);
    if (super.size > this.cap) {
      const oldest = super.keys().next().value;
      if (oldest !== void 0) {
        const evicted = super.get(oldest);
        super.delete(oldest);
        try {
          this.onEvict?.(oldest, evicted);
        } catch {
        }
      }
    }
    return this;
  }
};
function emptyEntry() {
  return {
    basedOnSeq: 0,
    basedOnStructuralCount: 0,
    prose: "",
    model: "",
    updatedAt: 0,
    negativeUntil: 0,
    inFlight: null,
    inFlightSnapshotSeq: 0,
    inFlightStructural: 0
  };
}
var BriefService = class {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
  }
  cache = new BoundedSessionCache();
  /** Live cache entries (diagnostics/tests; the map is LRU-bounded). */
  get cacheSize() {
    return this.cache.size;
  }
  /**
   * Drop the session's cached brief — the `session/disposed` eviction path.
   * A later call recomputes from the log, so eviction is behavior-neutral.
   * @param sessionId - the disposed session's id.
   */
  forget(sessionId) {
    this.cache.delete(sessionId);
  }
  /**
   * Materialize (or reuse) the session's prose brief.
   *
   * Cache policy: negative-cache → anti-thrash floor → structural distance →
   * single-flight join → distill. Never throws for provider failures — it
   * returns `{ ok: false }` (soft-degrading, frozen doc principle). Throws
   * only when the CALLER's signal aborts (the consumer is being cancelled).
   */
  async ensureFreshBrief(session, signal) {
    if (!keeperEnabled(this.ctx)) {
      return { ok: false, prose: null, reason: "keeper-disabled" };
    }
    const key = session.id;
    const cfg = resolveKeeperParams(this.ctx, this.config);
    const entry = this.cache.get(key);
    const now = Date.now();
    if (entry !== void 0 && entry.negativeUntil > now) {
      return { ok: false, prose: null, reason: "negative-cached" };
    }
    if (entry !== void 0 && entry.prose.length > 0 && now - entry.updatedAt < (cfg.minRefreshMs ?? 6e4)) {
      return { ok: true, prose: entry.prose, model: entry.model, reason: "cache-hit" };
    }
    if (entry !== void 0 && entry.prose.length > 0) {
      const distance = structuralTotal(session) - entry.basedOnStructuralCount;
      if (distance <= (cfg.structuralDistanceK ?? 24)) {
        return { ok: true, prose: entry.prose, model: entry.model, reason: "cache-hit" };
      }
    }
    if (entry !== void 0 && entry.inFlight !== null) {
      const inFlightDistance = structuralTotal(session) - entry.inFlightStructural;
      if (inFlightDistance <= (cfg.structuralDistanceK ?? 24)) {
        try {
          return await entry.inFlight;
        } catch (error) {
          if (signal?.aborted) throw error;
          return { ok: false, prose: null, reason: "failed" };
        }
      }
    }
    const snapshotSeq = session.seq;
    const promise = this.distill(session, signal, snapshotSeq, cfg);
    this.cache.set(key, {
      ...entry ?? emptyEntry(),
      inFlight: promise,
      inFlightSnapshotSeq: snapshotSeq,
      inFlightStructural: structuralTotal(session)
    });
    try {
      return await promise;
    } finally {
      const current = this.cache.get(key);
      if (current !== void 0 && current.inFlight === promise) {
        this.cache.set(key, { ...current, inFlight: null });
      }
    }
  }
  /**
   * Whether a background prefetch is warranted right now. Consumers wait only
   * 4 s for prose (oracle/council), while a live distillation can take ~7 s —
   * so after a turn/end that leaves the projection structurally stale the
   * keeper warms the cache itself instead of making the next consumer miss.
   *
   * Honours the same floors as `ensureFreshBrief`: the anti-thrash floor
   * (minRefreshMs), the failure negative cache, and single-flight. Pure read —
   * never triggers work by itself.
   * @param session - the session whose projection may be stale.
   * @returns whether the caller should schedule a prefetch.
   */
  prefetchDue(session) {
    if (!keeperEnabled(this.ctx)) return false;
    const cfg = resolveKeeperParams(this.ctx, this.config);
    const now = Date.now();
    const entry = this.cache.get(session.id);
    if (entry !== void 0) {
      if (entry.negativeUntil > now) return false;
      if (entry.inFlight !== null) return false;
      if (entry.prose.length > 0 && now - entry.updatedAt < (cfg.minRefreshMs ?? 6e4)) return false;
    }
    const distance = structuralTotal(session) - (entry?.basedOnStructuralCount ?? 0);
    return distance > (cfg.structuralDistanceK ?? 24);
  }
  /** One distillation pass: lease-bound LLM call, then append + cache. */
  async distill(session, signal, snapshotSeq, cfg) {
    const lease = new AbortController();
    const leaseTimer = setTimeout(() => lease.abort(), cfg.leaseMs ?? 45e3);
    const combined = signal !== void 0 ? AbortSignal.any([signal, lease.signal]) : lease.signal;
    try {
      const input = frameInput(session, cfg.maxInputEvents ?? 80);
      if (input.length === 0) {
        diag(`ensureFreshBrief: session=${session.id} \u2014 empty input, skipping`);
        return { ok: false, prose: null, reason: "failed" };
      }
      const route = resolveKeeperRoute(this.ctx, cfg);
      const snapshotStructural = structuralTotal(session);
      diag(`ensureFreshBrief: session=${session.id} \u2014 calling LLM (input ${input.length} chars, route ${route.provider}/${route.model}, basedOnSeq ${snapshotSeq})`);
      const result = await summarize(this.ctx, cfg, session, input, combined, route, PROSE_PROMPT, false);
      const prose = cleanKeeperProse(result.text);
      if (prose.length === 0) {
        diag(`ensureFreshBrief: session=${session.id} \u2014 empty or cleaned-empty prose, skipping`);
        return { ok: false, prose: null, reason: "failed" };
      }
      session.append("brief/prose-updated", {
        basedOnSeq: snapshotSeq,
        basedOnStructuralCount: snapshotStructural,
        structuralDistanceK: cfg.structuralDistanceK ?? 24,
        model: result.route,
        text: prose,
        origin: "context-keeper"
      });
      const current = this.cache.get(session.id);
      this.cache.set(session.id, {
        ...current ?? emptyEntry(),
        basedOnSeq: snapshotSeq,
        basedOnStructuralCount: snapshotStructural,
        prose,
        model: result.route,
        updatedAt: Date.now(),
        negativeUntil: 0
      });
      diag(`ensureFreshBrief: session=${session.id} \u2014 appended brief/prose-updated via ${result.route} (${prose.length} chars, basedOnSeq ${snapshotSeq})`);
      return { ok: true, prose, model: result.route, reason: "distilled" };
    } catch (error) {
      if (signal?.aborted) throw error;
      const entry = this.cache.get(session.id);
      this.cache.set(session.id, {
        ...entry ?? emptyEntry(),
        negativeUntil: Date.now() + (cfg.negativeCacheMs ?? 12e4)
      });
      diag(`ensureFreshBrief: session=${session.id} \u2014 FAILED ${String(error)} (negative-cached ${cfg.negativeCacheMs ?? 12e4}ms)`);
      return { ok: false, prose: null, reason: "failed" };
    } finally {
      clearTimeout(leaseTimer);
    }
  }
};
var BRIEF_SERVICE_ANCHOR = Symbol.for("enpoi.context-keeper.brief-service");
var briefService = null;
var PREFETCH_DEBOUNCE_MS = 2e3;
function getBriefService() {
  const anchored = globalThis[BRIEF_SERVICE_ANCHOR];
  return anchored ?? briefService;
}
function createBriefService(ctx, config) {
  return new BriefService(ctx, config);
}
var KEEPER_MESSAGE_KIND = "enpoi-keeper";
var CHECKPOINT_SOURCE = { kind: KEEPER_MESSAGE_KIND };
function checkpointTelemetry(session, meta) {
  const day = (value2) => {
    if (value2 === void 0 || !Number.isFinite(value2)) return "unknown";
    try {
      return new Date(value2).toISOString().slice(0, 10);
    } catch {
      return "unknown";
    }
  };
  const parts = [];
  const startedAt = session.header?.createdAt;
  parts.push(`session started ${day(startedAt)}`);
  try {
    const events = session.snapshotEvents();
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.type !== "turn/start") continue;
      const turn = event.data.turn;
      if (typeof turn === "number" && Number.isFinite(turn)) parts.push(`turn ${turn}`);
      break;
    }
  } catch {
  }
  parts.push(`today ${day(Date.now())}`);
  parts.push(`refreshed at seq ${meta.seq}`);
  parts.push(`by ${meta.model}`);
  parts.push(`via ${meta.via}`);
  return parts.join(" \xB7 ");
}
function renderCheckpointBlock(data) {
  const text = typeof data.text === "string" ? data.text.trim() : "";
  return ["### State checkpoint", text, data.telemetry].filter((line) => line.length > 0).join("\n\n");
}
function buildTemplateCheckpoint(session) {
  try {
    const events = session.snapshotEvents();
    let firstUser = "";
    let lastUser = "";
    let lastAssistant = "";
    let lastError = "";
    const docFiles = /* @__PURE__ */ new Set();
    for (const event of events) {
      if (event.type === "user/message") {
        const text = messageText(event.data.content).trim();
        if (text.length > 0) {
          if (firstUser.length === 0) firstUser = text;
          lastUser = text;
        }
      } else if (event.type === "assistant/message") {
        const text = assistantMessageText(event.data);
        if (text.length > 0) lastAssistant = text;
      } else if (event.type === "tool/call") {
        const args = event.data.arguments;
        if (typeof args === "string") {
          const matches = args.match(/["']([^"']*\.(?:md|json|yaml|yml))["']/g);
          if (matches !== null) {
            for (const match of matches) {
              const clean = match.replace(/["']/g, "");
              if (clean.length > 2 && docFiles.size < 8) docFiles.add(clean);
            }
          }
        }
      } else if (event.type === "tool/result") {
        const error = event.data.error;
        if (typeof error?.message === "string" && error.message.length > 0) lastError = error.message.slice(0, 300);
      }
    }
    const clip = (text, max) => text.length > max ? `${text.slice(0, max)}\u2026` : text;
    const sections = [];
    if (firstUser.length > 0 || lastUser.length > 0) {
      const goal = firstUser.length > 0 ? `- Objective: ${clip(firstUser.replace(/\s+/g, " "), 300)}` : "";
      const latest = lastUser.length > 0 && lastUser !== firstUser ? `- Latest directive: ${clip(lastUser.replace(/\s+/g, " "), 300)}` : "";
      sections.push(["\u{1F3AF} ACTIVE GOAL & CORE TRAJECTORY:", goal, latest].filter((line) => line.length > 0).join("\n"));
    }
    if (docFiles.size > 0) {
      sections.push(["\u{1F4DA} DOCUMENTATION & SPECIFICATIONS INVENTORY:", ...[...docFiles].map((file) => `- ${file}`)].join("\n"));
    }
    if (lastAssistant.length > 0) {
      const decision = clip(lastAssistant.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)[0] ?? "", 300);
      if (decision.length > 0) sections.push(["\u{1F3DB}\uFE0F ARCHITECTURAL INVARIANTS & CONCRETE DECISIONS:", `- ${decision}`].join("\n"));
    }
    if (lastError.length > 0) {
      sections.push(["\u26A1 ACTIVE BLOCKERS & OPEN QUESTIONS:", `- Last tool error: ${lastError}`].join("\n"));
    }
    return sections.join("\n\n");
  } catch (error) {
    diag(`buildTemplateCheckpoint: fold failed (${String(error)})`);
    return "";
  }
}
var checkpointCursors = /* @__PURE__ */ new WeakMap();
function latestCheckpoint(session) {
  const known = checkpointCursors.get(session);
  if (known !== void 0 && session.seq <= known.seq) return known.data;
  let data = known?.data ?? null;
  const from = known?.seq ?? 0;
  try {
    for (const event of session.snapshotEvents(SessionLogOffset(from))) {
      if (event.type !== "state/checkpoint") continue;
      const candidate = event.data;
      if (typeof candidate?.text === "string" || typeof candidate?.telemetry === "string") {
        data = {
          version: typeof candidate.version === "number" ? candidate.version : 0,
          basedOnSeq: typeof candidate.basedOnSeq === "number" ? candidate.basedOnSeq : 0,
          basedOnStructuralCount: typeof candidate.basedOnStructuralCount === "number" ? candidate.basedOnStructuralCount : 0,
          model: typeof candidate.model === "string" ? candidate.model : "unknown",
          via: candidate.via === "llm" ? "llm" : "template",
          text: typeof candidate.text === "string" ? candidate.text : "",
          telemetry: typeof candidate.telemetry === "string" ? candidate.telemetry : "",
          createdAt: typeof candidate.createdAt === "number" ? candidate.createdAt : 0
        };
      }
    }
  } catch (error) {
    diag(`latestCheckpoint: read failed (${String(error)})`);
  }
  checkpointCursors.set(session, { seq: session.seq, data });
  return data;
}
function appendCheckpoint(session, data) {
  const append = session.append;
  append.call(session, "state/checkpoint", data, { ignorable: true });
}
function latestCheckpointMessageSeq(session) {
  const surface = new Set(session.surface.nodes);
  if (surface.size === 0) return null;
  let found = null;
  try {
    for (const event of session.snapshotEvents()) {
      if (event.type !== "user/message") continue;
      const source = event.data.source;
      if (source?.kind !== KEEPER_MESSAGE_KIND) continue;
      if (surface.has(event.seq)) found = event.seq;
    }
  } catch (error) {
    diag(`latestCheckpointMessageSeq: read failed (${String(error)})`);
  }
  return found;
}
function commitCheckpointMessage(session, text) {
  const append = session.append;
  const message = createUserMessage({
    content: [{ type: "text", text }],
    source: { ...CHECKPOINT_SOURCE }
  });
  const previous = latestCheckpointMessageSeq(session);
  if (previous !== null) {
    try {
      append.call(session, "user/message", message, {
        surfaceOp: { op: "replace", startSeq: previous, endSeq: previous },
        sourceEventSeqs: [previous]
      });
      return;
    } catch (error) {
      diag(`commitCheckpointMessage: replace of seq ${previous} failed, appending (${String(error)})`);
    }
  }
  append.call(session, "user/message", message, { surfaceOp: "append" });
}
var CheckpointService = class {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
  }
  cache = new BoundedSessionCache();
  /** Live cache entries (diagnostics/tests; the map is LRU-bounded). */
  get cacheSize() {
    return this.cache.size;
  }
  /**
   * Drop the session's cached checkpoint — the `session/disposed` eviction
   * path. The log is the durable source of truth, so a later call rehydrates
   * from the newest `state/checkpoint` (behavior-neutral).
   * @param sessionId - the disposed session's id.
   */
  forget(sessionId) {
    this.cache.delete(sessionId);
  }
  /**
   * Ensure the session's state checkpoint is fresh.
   *
   * `force` (a segment cut) refreshes even inside the freshness window: the
   * boundary busts the prompt cache anyway, and the keeper's brief is a
   * point-in-time snapshot by contract. Never throws for provider failures —
   * the deterministic template always yields a valid checkpoint.
   * @param session - the session to checkpoint.
   * @param opts - `force` for a segment-cut refresh.
   * @returns whether the checkpoint is present and how it was produced.
   */
  async ensureCheckpoint(session, opts = {}) {
    if (!keeperEnabled(this.ctx)) return { ok: false, text: null, reason: "keeper-disabled" };
    const cfg = resolveKeeperParams(this.ctx, this.config);
    const key = session.id;
    const now = Date.now();
    let entry = this.cache.get(key);
    if (entry === void 0) {
      const logged = latestCheckpoint(session);
      if (logged !== null) {
        entry = {
          version: logged.version,
          basedOnSeq: logged.basedOnSeq,
          basedOnStructuralCount: logged.basedOnStructuralCount,
          text: logged.text,
          model: logged.model,
          via: logged.via,
          createdAt: logged.createdAt,
          inFlight: null
        };
        this.cache.set(key, entry);
      }
    }
    const structural = structuralTotal(session);
    if (entry !== void 0 && opts.force !== true) {
      const freshStructural = structural - entry.basedOnStructuralCount < (cfg.checkpointStaleEvents ?? 12);
      const freshAge = now - entry.createdAt < (cfg.checkpointStaleHours ?? 24) * 36e5;
      if (freshStructural && freshAge) {
        return { ok: true, text: entry.text, model: entry.model, reason: "cache-hit" };
      }
    }
    if (entry?.inFlight != null) {
      try {
        return await entry.inFlight;
      } catch {
        return { ok: false, text: null, reason: "refreshed" };
      }
    }
    const snapshotSeq = session.seq;
    const promise = this.refresh(session, snapshotSeq, cfg, structural);
    this.cache.set(key, {
      ...entry ?? {
        version: 0,
        basedOnSeq: 0,
        basedOnStructuralCount: 0,
        text: "",
        model: "",
        via: "template",
        createdAt: 0
      },
      inFlight: promise
    });
    try {
      return await promise;
    } finally {
      const current = this.cache.get(key);
      if (current !== void 0 && current.inFlight === promise) this.cache.set(key, { ...current, inFlight: null });
    }
  }
  /** One refresh: model chain, then the deterministic template fallback. */
  async refresh(session, snapshotSeq, cfg, structural) {
    let text = "";
    let model = "template";
    let via = "template";
    const lease = new AbortController();
    const leaseTimer = setTimeout(() => lease.abort(), cfg.leaseMs ?? 45e3);
    try {
      const input = frameInput(session, cfg.maxInputEvents ?? 80);
      if (input.length > 0) {
        const route = resolveKeeperRoute(this.ctx, cfg);
        diag(`ensureCheckpoint: session=${session.id} \u2014 calling LLM (input ${input.length} chars, route ${route.provider}/${route.model}, basedOnSeq ${snapshotSeq})`);
        const result = await summarize(this.ctx, cfg, session, input, lease.signal, route, PROSE_PROMPT, false);
        const prose = cleanKeeperProse(result.text);
        if (prose.length > 0) {
          text = prose;
          model = result.route;
          via = "llm";
        }
      }
    } catch (error) {
      diag(`ensureCheckpoint: session=${session.id} \u2014 model path failed, using template (${String(error)})`);
    } finally {
      clearTimeout(leaseTimer);
    }
    if (via === "template") {
      text = buildTemplateCheckpoint(session);
      model = "template";
    }
    const current = this.cache.get(session.id);
    const version = (latestCheckpoint(session)?.version ?? current?.version ?? 0) + 1;
    const data = {
      version,
      basedOnSeq: snapshotSeq,
      basedOnStructuralCount: structural,
      model,
      via,
      text,
      telemetry: checkpointTelemetry(session, { seq: snapshotSeq, model, via }),
      createdAt: Date.now()
    };
    try {
      appendCheckpoint(session, data);
      commitCheckpointMessage(session, renderCheckpointBlock(data));
    } catch (error) {
      diag(`ensureCheckpoint: session=${session.id} \u2014 commit failed (${String(error)})`);
      return { ok: false, text: null, reason: "refreshed" };
    }
    checkpointCursors.set(session, { seq: session.seq, data });
    this.cache.set(session.id, {
      version,
      basedOnSeq: snapshotSeq,
      basedOnStructuralCount: structural,
      text,
      model,
      via,
      createdAt: data.createdAt,
      inFlight: current?.inFlight ?? null
    });
    diag(`ensureCheckpoint: session=${session.id} \u2014 appended state/checkpoint v${version} via ${via} (${text.length} chars)`);
    return { ok: true, text, model, reason: "refreshed" };
  }
};
function pressureAboveHalf(ctx, session) {
  try {
    const window = session.requestContext?.()?.contextWindow;
    if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) return true;
    const meter = ctx.get("tokenMeter");
    const used = meter?.measure?.(session)?.totalTokens;
    if (typeof used !== "number" || !Number.isFinite(used)) return true;
    return used >= window * 0.5;
  } catch {
    return true;
  }
}
var CHECKPOINT_SERVICE_ANCHOR = Symbol.for("enpoi.context-keeper.checkpoint-service");
var checkpointService = null;
function getCheckpointService() {
  const anchored = globalThis[CHECKPOINT_SERVICE_ANCHOR];
  return anchored ?? checkpointService;
}
function createCheckpointService(ctx, config) {
  return new CheckpointService(ctx, config);
}
var bookkeeping = null;
function getKeeperBookkeeping() {
  return bookkeeping;
}
function apply(ctx, config) {
  config = plainConfig(config);
  const ownedService = createBriefService(ctx, config);
  briefService = ownedService;
  globalThis[BRIEF_SERVICE_ANCHOR] = ownedService;
  const ownedCheckpoint = createCheckpointService(ctx, config);
  checkpointService = ownedCheckpoint;
  globalThis[CHECKPOINT_SERVICE_ANCHOR] = ownedCheckpoint;
  diag(`apply: mounted (demand-driven; prose on oracle/council use, state checkpoint on segment cuts + staleness floor, surface replace in place, claims batched ${config.claimsBatchSize ?? 8}/${config.claimsBatchMinutes ?? 5}min)`);
  const prefetchTimers = /* @__PURE__ */ new Map();
  const prefetchRunning = /* @__PURE__ */ new Set();
  const runPrefetch = (session) => {
    if (prefetchRunning.has(session.id)) return;
    prefetchRunning.add(session.id);
    void ownedService.ensureFreshBrief(session).then((result) => {
      diag(`prefetch: session=${session.id} \u2014 landed (${result.reason}, ${result.prose?.length ?? 0} chars, model ${result.model ?? "n/a"})`);
    }).catch((error) => {
      diag(`prefetch: session=${session.id} \u2014 failed (${String(error)})`);
    }).finally(() => {
      prefetchRunning.delete(session.id);
    });
  };
  const schedulePrefetch = (session) => {
    try {
      if (!ownedService.prefetchDue(session)) return;
      if (prefetchTimers.has(session.id)) return;
      const timer = setTimeout(() => {
        prefetchTimers.delete(session.id);
        runPrefetch(session);
      }, PREFETCH_DEBOUNCE_MS);
      timer.unref?.();
      prefetchTimers.set(session.id, timer);
    } catch {
    }
  };
  const claimCounters = new BoundedSessionCache(
    KEEPER_CACHE_CAP,
    (_id, counter) => {
      if (counter.timer !== null) clearTimeout(counter.timer);
    }
  );
  const claimsRunning = /* @__PURE__ */ new Set();
  const ownedBookkeeping = {
    claimCounters: () => claimCounters.size,
    prefetchTimers: () => prefetchTimers.size,
    prefetchRunning: () => prefetchRunning.size,
    claimsRunning: () => claimsRunning.size
  };
  bookkeeping = ownedBookkeeping;
  ctx.on("session/disposed", (session) => {
    ownedService.forget(session.id);
    ownedCheckpoint.forget(session.id);
    const counter = claimCounters.get(session.id);
    if (counter !== void 0) {
      if (counter.timer !== null) clearTimeout(counter.timer);
      claimCounters.delete(session.id);
    }
    const prefetchTimer = prefetchTimers.get(session.id);
    if (prefetchTimer !== void 0) {
      clearTimeout(prefetchTimer);
      prefetchTimers.delete(session.id);
    }
    prefetchRunning.delete(session.id);
    claimsRunning.delete(session.id);
  });
  ctx.on("session/event", (session, event) => {
    if (STRUCTURAL_TYPES.has(event.type)) {
      const known = structuralCounters.get(session);
      if (known !== void 0 && Number.isFinite(event.seq)) {
        structuralCounters.set(session, { seq: event.seq + 1, total: known.total + 1 });
      }
    }
    if (event.type === "state/checkpoint") {
      checkpointCursors.set(session, { seq: event.seq + 1, data: event.data });
    }
    if ((event.type === "compaction/end" || event.type === "compaction/summary") && keeperEnabled(ctx)) {
      void ownedCheckpoint.ensureCheckpoint(session, { force: true }).catch(() => {
      });
    }
    if (event.type !== "turn/end") return;
    if (!keeperEnabled(ctx)) return;
    const reason = event.data.reason;
    if (reason.kind === "aborted") return;
    maybeScheduleStaleCheckpoint(ctx, config, session, ownedCheckpoint);
    schedulePrefetch(session);
    let counter = claimCounters.get(session.id);
    if (counter === void 0) {
      counter = { count: 0, timer: null };
      claimCounters.set(session.id, counter);
    }
    counter.count += 1;
    if (counter.timer !== null) clearTimeout(counter.timer);
    counter.timer = setTimeout(() => {
      counter.timer = null;
      void runClaimsPass(ctx, config, session, claimsRunning);
    }, (config.claimsBatchMinutes ?? 5) * 6e4);
    if (counter.count >= (config.claimsBatchSize ?? 8)) {
      counter.count = 0;
      if (counter.timer !== null) {
        clearTimeout(counter.timer);
        counter.timer = null;
      }
      void runClaimsPass(ctx, config, session, claimsRunning);
    }
  });
  ctx.on("dispose", () => {
    for (const counter of claimCounters.values()) {
      if (counter.timer !== null) clearTimeout(counter.timer);
    }
    claimCounters.clear();
    claimsRunning.clear();
    for (const timer of prefetchTimers.values()) clearTimeout(timer);
    prefetchTimers.clear();
    prefetchRunning.clear();
    if (briefService === ownedService) briefService = null;
    if (globalThis[BRIEF_SERVICE_ANCHOR] === ownedService) {
      delete globalThis[BRIEF_SERVICE_ANCHOR];
    }
    if (checkpointService === ownedCheckpoint) checkpointService = null;
    if (globalThis[CHECKPOINT_SERVICE_ANCHOR] === ownedCheckpoint) {
      delete globalThis[CHECKPOINT_SERVICE_ANCHOR];
    }
    if (bookkeeping === ownedBookkeeping) bookkeeping = null;
  });
}
function maybeScheduleStaleCheckpoint(ctx, config, session, service) {
  try {
    const cfg = resolveKeeperParams(ctx, config);
    const last = latestCheckpoint(session);
    const structural = structuralTotal(session);
    const floorMet = last === null ? structural >= (cfg.checkpointStaleEvents ?? 12) : structural - last.basedOnStructuralCount >= (cfg.checkpointStaleEvents ?? 12) || Date.now() - last.createdAt >= (cfg.checkpointStaleHours ?? 24) * 36e5;
    if (!floorMet) {
      if (last === null || !pressureAboveHalf(ctx, session)) return;
    }
    void service.ensureCheckpoint(session).catch(() => {
    });
  } catch {
  }
}
async function runClaimsPass(ctx, config, session, running) {
  if (running.has(session.id)) return;
  running.add(session.id);
  const cfg = resolveKeeperParams(ctx, config);
  const lease = new AbortController();
  const leaseTimer = setTimeout(() => lease.abort(), cfg.leaseMs ?? 45e3);
  try {
    const input = frameInput(session, cfg.maxInputEvents ?? 80);
    if (input.length === 0) return;
    const route = resolveKeeperRoute(ctx, cfg);
    diag(`claims: session=${session.id} \u2014 calling LLM (input ${input.length} chars, route ${route.provider}/${route.model})`);
    const result = await summarize(ctx, cfg, session, input, lease.signal, route, CLAIMS_PROMPT, true);
    const claims = splitClaims(result.text);
    if (claims.length === 0) {
      diag(`claims: session=${session.id} \u2014 no claims extracted`);
      return;
    }
    const memDb = openMemoryDb();
    try {
      const mem = makePipeline(memDb);
      const provenance = JSON.stringify({ sessionId: session.id });
      const toolClaims = claims.filter((c) => c.source === "tool");
      const chatClaims = claims.filter((c) => c.source !== "tool");
      if (toolClaims.length > 0) {
        await mem.intake(
          toolClaims.map((c) => ({ fact: c.fact, category: c.category, tags: c.tags })),
          { origin: "keeper", trust: "verified_execution", provenance }
        );
      }
      if (chatClaims.length > 0) {
        await mem.intake(
          chatClaims.map((c) => ({ fact: c.fact, category: c.category, tags: c.tags })),
          { origin: "keeper", trust: "operator", provenance }
        );
      }
      diag(`claims: session=${session.id} \u2014 ${toolClaims.length} tool + ${chatClaims.length} chat claim(s) filed`);
    } finally {
      memDb.close();
    }
  } catch (error) {
    diag(`claims: session=${session.id} \u2014 FAILED ${String(error)}`);
  } finally {
    clearTimeout(leaseTimer);
    running.delete(session.id);
  }
}
var PROSE_REJECT_MARKERS = ["<dots_function_call", "<function_call", "tool_call", "<tool_use"];
function isToolEnvelopeValue(value2, depth = 0) {
  if (depth > 4 || value2 === null || typeof value2 !== "object") return false;
  if (Array.isArray(value2)) return value2.some((item) => isToolEnvelopeValue(item, depth + 1));
  const record = value2;
  if (typeof record.name === "string" && (typeof record.arguments === "string" || record.arguments !== null && typeof record.arguments === "object")) {
    return true;
  }
  if (Array.isArray(record.tool_calls) && record.tool_calls.length > 0) return true;
  for (const key of ["function_call", "tool_call", "tool_use", "toolUse"]) {
    if (record[key] !== null && typeof record[key] === "object") return true;
  }
  return false;
}
function isToolJsonEnvelope(text) {
  if (!text.startsWith("{") && !text.startsWith("[")) return false;
  try {
    return isToolEnvelopeValue(JSON.parse(text));
  } catch {
    return false;
  }
}
function isMostlyMarkup(text) {
  if (/[🎯📚🏛️🚫⚡]/.test(text)) return false;
  const tags = text.match(/<[^>]{0,300}>/g);
  if (tags === null || tags.length < 3) return false;
  const tagChars = tags.reduce((sum, tag) => sum + tag.length, 0);
  const total = text.replace(/\s+/g, "").length;
  return total > 0 && tagChars / total >= 0.4;
}
function keeperProseRejection(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "empty output";
  if (isToolJsonEnvelope(trimmed)) return "JSON tool-call envelope";
  const lower = trimmed.toLowerCase();
  for (const marker of PROSE_REJECT_MARKERS) {
    if (lower.includes(marker)) return `tool-call/function-call echo (${marker})`;
  }
  if (isMostlyMarkup(trimmed)) return "output is mostly markup";
  return null;
}
var KEEPER_SECTION_HEADERS_GLOBAL = /^[🎯📚🏛️🚫⚡]\s*/gm;
var KEEPER_MIN_BRIEF_CHARS = 40;
var KEEPER_MIN_BRIEF_SECTIONS = 1;
var KEEPER_MIN_BRIEF_BULLETS = 1;
function keeperBriefShapeRejection(text) {
  const sections = text.match(KEEPER_SECTION_HEADERS_GLOBAL)?.length ?? 0;
  if (sections < KEEPER_MIN_BRIEF_SECTIONS) return "brief has no section header";
  const bullets = (text.match(/^\s*-\s+\S/gm) ?? []).length;
  if (bullets < KEEPER_MIN_BRIEF_BULLETS) return "brief has no bullet content";
  if (text.trim().length < KEEPER_MIN_BRIEF_CHARS) {
    return `brief is below the minimum length (${KEEPER_MIN_BRIEF_CHARS} chars)`;
  }
  return null;
}
function cleanKeeperProse(text) {
  if (!text || text.trim().length === 0) return "";
  if (keeperProseRejection(text) !== null) return "";
  if (keeperBriefShapeRejection(text) !== null) return "";
  const sectionChunks = text.split(/(?=^[🎯📚🏛️🚫⚡]\s*)/m);
  const cleaned = [];
  for (const chunk of sectionChunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const lines = trimmed.split("\n");
    const contentLines = lines.slice(1).map((l) => l.trim()).filter(Boolean);
    if (contentLines.length === 0) continue;
    const isAllNegativeFiller = contentLines.every(
      (l) => /^-\s*(no\b|none\b|n\/a\b|nothing\b|not applicable\b)/i.test(l) || /no documentation.*(?:created|referenced|modified|identified)/i.test(l) || /no alternative approaches/i.test(l) || /no blockers/i.test(l) || /no open questions/i.test(l) || /no edge cases/i.test(l)
    );
    if (!isAllNegativeFiller) {
      cleaned.push(trimmed);
    }
  }
  const cleanedText = cleaned.join("\n\n");
  return cleanedText.length < KEEPER_MIN_BRIEF_CHARS ? "" : cleanedText;
}
function splitClaims(text) {
  const idx = text.indexOf("CLAIMS:");
  if (idx === -1) return [];
  const jsonPart = text.slice(idx + "CLAIMS:".length).trim();
  try {
    const json = extractClaimsJsonArray(jsonPart);
    if (json === null) return [];
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.filter((c) => typeof c === "object" && c !== null && typeof c.fact === "string").map((c) => ({
      fact: String(c.fact).trim().slice(0, 300),
      category: String(c.category ?? "PROJECT").slice(0, 32),
      tags: typeof c.tags === "string" ? c.tags : void 0,
      source: c.source === "tool" ? "tool" : "chat"
    })).filter((c) => c.fact.length > 0);
  } catch {
    diag("splitClaims: CLAIMS JSON parse failed (isolated)");
    return [];
  }
}
function frameInput(session, maxEvents) {
  const events = session.snapshotEvents();
  let previousProse = "";
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const candidate = e.type === "state/checkpoint" || e.type === "brief/prose-updated" ? e.data.text : void 0;
    if (typeof candidate === "string" && candidate.length > 0) {
      previousProse = candidate.slice(0, 4e3);
      break;
    }
  }
  const start = Math.max(0, events.length - maxEvents);
  const lines = [];
  const docFiles = /* @__PURE__ */ new Set();
  for (let i = start; i < events.length; i++) {
    const event = events[i];
    if (event.type === "user/message") {
      const text = messageText(event.data.content);
      if (text.length > 0) lines.push(`USER: ${text.slice(0, 2500)}`);
    } else if (event.type === "assistant/message") {
      const text = assistantMessageText(event.data);
      if (text.length > 0) {
        lines.push(`ASSISTANT: ${text.slice(0, 2500)}`);
      }
    } else if (event.type === "tool/call") {
      const data = event.data;
      const argsStr = typeof data.arguments === "string" && data.arguments.length > 0 ? ` ${data.arguments.slice(0, 600)}` : "";
      lines.push(`TOOL CALL: ${data.name}${argsStr}`);
      if (data.arguments) {
        const matches = data.arguments.match(/["']([^"']*\.(?:md|json|yaml|yml))["']/g);
        if (matches) {
          for (const m of matches) {
            const clean = m.replace(/["']/g, "");
            if (clean.length > 2) docFiles.add(clean);
          }
        }
      }
    } else if (event.type === "tool/result") {
      const resultText = toolResultText(event.data);
      if (resultText.length > 0) {
        lines.push(`TOOL RESULT: ${resultText.slice(0, 4e3)}`);
      }
    }
  }
  const sections = [];
  if (previousProse.length > 0) {
    sections.push(`--- PREVIOUS SESSION BRIEF ---
${previousProse}`);
  }
  if (docFiles.size > 0) {
    sections.push(`--- RECENT SPECIFICATION & DOCUMENTATION FILES ---
${Array.from(docFiles).map((f) => `\u2022 ${f}`).join("\n")}`);
  }
  if (lines.length > 0) {
    sections.push(`--- RECENT SESSION EVENTS & TOOL RESULTS ---
${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}
function assistantMessageText(data) {
  if (!data || typeof data !== "object") return "";
  const record = data;
  if (typeof record.text === "string" && record.text.trim().length > 0) return record.text.trim();
  if (!Array.isArray(record.message?.content)) return "";
  const parts = [];
  for (const block of record.message.content) {
    if (block !== null && typeof block === "object" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}
function toolResultText(data) {
  if (!data || typeof data !== "object") return "";
  const d = data;
  if (d.error?.message) return `Error: ${d.error.message}`;
  if (!d.message || !Array.isArray(d.message.content)) return "";
  const parts = [];
  for (const block of d.message.content) {
    if (typeof block === "string") parts.push(block);
    else if (block && typeof block === "object") {
      const b = block;
      if (typeof b.text === "string") parts.push(b.text);
      if (Array.isArray(b.content)) {
        for (const sub of b.content) {
          if (typeof sub === "string") parts.push(sub);
          else if (sub && typeof sub === "object" && typeof sub.text === "string") {
            parts.push(sub.text);
          }
        }
      }
    }
  }
  return parts.filter(Boolean).join(" ").trim();
}
function messageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part !== null && typeof part === "object" && "text" in part && typeof part.text === "string") {
        return part.text;
      }
      return "";
    }).filter((text) => text.length > 0).join(" ");
  }
  return "";
}
function extractClaimsJsonArray(text) {
  const start = text.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}
function validateKeeperOutput(text, finishKind, expectClaims = false) {
  if (finishKind === "max-tokens") {
    return { valid: false, reason: "Stream truncated by maxOutputTokens limit" };
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { valid: false, reason: "Empty output received from model" };
  }
  if (!expectClaims) {
    const rejection = keeperProseRejection(trimmed);
    if (rejection !== null) {
      return { valid: false, reason: `Rejected keeper prose: ${rejection}` };
    }
  }
  if (expectClaims) {
    const claimsMatch = trimmed.match(/CLAIMS:\s*([\s\S]*)$/i);
    if (claimsMatch) {
      const rawClaims = claimsMatch[1].trim();
      if (/^(none|n\/a|\[\s*\])$/i.test(rawClaims)) {
        return { valid: true };
      }
      const json = extractClaimsJsonArray(rawClaims);
      if (json === null) {
        return { valid: false, reason: "CLAIMS tag present but JSON array was truncated/unclosed", cutLike: true };
      }
      try {
        JSON.parse(json);
      } catch (e) {
        return { valid: false, reason: `Malformed CLAIMS JSON: ${String(e)}` };
      }
    }
  }
  return { valid: true };
}
var KEEPER_ROUTE_FAILURE_THRESHOLD = 2;
var KEEPER_ROUTE_QUARANTINE_MS = 5 * 6e4;
var keeperRouteHealth = /* @__PURE__ */ new Map();
function resetKeeperRouteHealth() {
  keeperRouteHealth.clear();
}
function keeperRouteQuarantineRemaining(provider, model, now = Date.now()) {
  const entry = keeperRouteHealth.get(`${provider}/${model}`);
  return entry !== void 0 && entry.quarantinedUntil > now ? entry.quarantinedUntil - now : 0;
}
function recordKeeperRouteFailure(provider, model) {
  const key = `${provider}/${model}`;
  const entry = keeperRouteHealth.get(key) ?? { failures: 0, quarantinedUntil: 0 };
  entry.failures += 1;
  if (entry.failures >= KEEPER_ROUTE_FAILURE_THRESHOLD) {
    entry.quarantinedUntil = Date.now() + KEEPER_ROUTE_QUARANTINE_MS;
  }
  keeperRouteHealth.set(key, entry);
  return entry;
}
function clearKeeperRouteFailure(provider, model) {
  keeperRouteHealth.delete(`${provider}/${model}`);
}
var REQUEST_LEVEL_FAILURE_CODES = /* @__PURE__ */ new Set([
  "CONTEXT_WINDOW_EXCEEDED",
  "INVALID_REQUEST",
  "UNSUPPORTED_CONTENT",
  "IMAGE_OFFLOAD_REQUIRED",
  // OpenCode's free-tier client gate: the route is policy-gated server-side
  // ("You cannot use the free tier in other harnesses", anomalyco/opencode#49621),
  // so a strike/quarantine would idle a link no credential can repair. The
  // free link is retired from default chains; this keeps a hand-enabled one
  // from poisoning route health while it explains itself.
  "FREE_TIER_GATED"
]);
var FREE_TIER_GATED_RE = /FreeTierError|free tier can only be used/i;
function keeperRouteRequestLevelFailure(error) {
  const code = error?.code;
  if (typeof code === "string" && REQUEST_LEVEL_FAILURE_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : error?.message;
  return typeof message === "string" && (isContextWindowExceededError(message) || FREE_TIER_GATED_RE.test(message));
}
async function summarize(ctx, config, session, input, signal, route, systemPrompt, expectClaims) {
  const messages = [createUserMessage({
    content: [{ type: "text", text: input }],
    source: { kind: KEEPER_MESSAGE_KIND }
  })];
  const base = {
    messages,
    system: systemPrompt,
    maxTokens: config.maxOutputTokens,
    sessionId: session.id,
    purpose: "context-keeper",
    signal
  };
  async function executeRoute(provider, model, maxTokens, reasoningEffort) {
    const result = await streamTextWithMeta(ctx, {
      ...base,
      maxTokens,
      provider,
      model,
      ...reasoningEffort !== void 0 ? { reasoningEffort } : {}
    });
    const validation = validateKeeperOutput(result.text, result.finishKind, expectClaims);
    if (!validation.valid) {
      const error = new Error(`Output invalid/truncated on ${provider}/${model}: ${validation.reason}`);
      if (validation.cutLike === true) error.code = MAX_TOKENS_CUT_CODE;
      throw error;
    }
    if (!expectClaims && cleanKeeperProse(result.text).length === 0) {
      const reason = keeperProseRejection(result.text) ?? keeperBriefShapeRejection(result.text) ?? "empty output after keeper cleaning";
      throw new Error(`Output invalid/truncated on ${provider}/${model}: ${reason}`);
    }
    return result.text;
  }
  const allAttempts = keeperAttempts(route);
  const enabledAttempts = allAttempts.filter(
    (attempt) => keeperRouteQuarantineRemaining(attempt.provider, attempt.model) === 0
  );
  const attempts = enabledAttempts.length > 0 ? enabledAttempts : allAttempts;
  if (enabledAttempts.length > 0 && attempts.length < allAttempts.length) {
    const skipped = allAttempts.filter((attempt) => keeperRouteQuarantineRemaining(attempt.provider, attempt.model) > 0).map((attempt) => `${attempt.provider}/${attempt.model}`);
    process.stderr.write(`[model-chain] ${route.chainId ?? "keeper"}: skipping quarantined link(s): ${skipped.join(", ")}
`);
  }
  const configuredCap = config.maxOutputTokens ?? 2048;
  const escalatedCap = Math.min(configuredCap * 2, KEEPER_MAX_OUTPUT_TOKENS);
  let lastError;
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    let failure;
    try {
      const text = await executeRoute(attempt.provider, attempt.model, configuredCap, attempt.reasoningEffort);
      clearKeeperRouteFailure(attempt.provider, attempt.model);
      if (index > 0) {
        process.stderr.write(`[model-chain] ${route.chainId ?? "keeper"}: recovered on link ${index + 1} (${attempt.provider}/${attempt.model})
`);
      }
      return { text, route: `${attempt.provider}/${attempt.model}` };
    } catch (error) {
      failure = error;
      if (!signal.aborted && isMaxTokensCut(error) && escalatedCap > configuredCap) {
        try {
          const text = await executeRoute(attempt.provider, attempt.model, escalatedCap, attempt.reasoningEffort);
          clearKeeperRouteFailure(attempt.provider, attempt.model);
          process.stderr.write(
            `[model-chain] ${route.chainId ?? "keeper"}: link ${index + 1} (${attempt.provider}/${attempt.model}) hit maxOutputTokens at ${configuredCap}; retried at ${escalatedCap} and recovered
`
          );
          return { text, route: `${attempt.provider}/${attempt.model}` };
        } catch (escalationError) {
          failure = escalationError;
        }
      }
    }
    if (signal.aborted) throw failure;
    if (keeperRouteRequestLevelFailure(failure)) {
      const message2 = failure instanceof Error ? failure.message : String(failure);
      process.stderr.write(
        `[model-chain] ${route.chainId ?? "keeper"}: link ${index + 1} (${attempt.provider}/${attempt.model}) rejected the request (no route strike): ${message2}
`
      );
    } else {
      const health = recordKeeperRouteFailure(attempt.provider, attempt.model);
      if (health.quarantinedUntil > Date.now()) {
        const until = new Date(health.quarantinedUntil).toISOString();
        process.stderr.write(
          `[model-chain] ${route.chainId ?? "keeper"}: route ${attempt.provider}/${attempt.model} quarantined until ${until} (${health.failures} consecutive failures)
`
        );
        diag(`route ${attempt.provider}/${attempt.model} quarantined until ${until} (${health.failures} consecutive failures)`);
      }
    }
    lastError = failure;
    const next = attempts[index + 1];
    if (next === void 0) break;
    const message = failure instanceof Error ? failure.message : String(failure);
    process.stderr.write(`[model-chain] ${route.chainId ?? "keeper"}: link ${index + 1} (${attempt.provider}/${attempt.model}) FAILED/CUT \u2192 link ${index + 2} (${next.provider}/${next.model}): ${message}
`);
    ctx.logger.warn(`enpoi-context-keeper: route ${attempt.provider}/${attempt.model} failed/cut off (${message}), advancing to ${next.provider}/${next.model}`);
    diag(`route ${attempt.provider}/${attempt.model} failed/cut off (${message}), advancing to ${next.provider}/${next.model}`);
  }
  throw new Error(`enpoi-context-keeper: all summary routes failed (${attempts.length} attempt(s)). Last: ${String(lastError)}`);
}
var MAX_TOKENS_CUT_CODE = "MAX_TOKENS_CUT";
function isMaxTokensCut(error) {
  return error instanceof Error && error.code === MAX_TOKENS_CUT_CODE;
}
async function streamTextWithMeta(ctx, options) {
  var _stack = [];
  try {
    const callDeadline = __using(_stack, deadline(options.signal, 4e4, "ENPOI_KEEPER_STREAM_TIMEOUT"));
    const assembler = new BlockAssembler();
    for await (const chunk of ctx.llm.stream({ ...options, signal: callDeadline.signal })) {
      callDeadline.signal.throwIfAborted();
      assembler.push(chunk);
    }
    callDeadline.signal.throwIfAborted();
    const terminalError = finishError(assembler.finish);
    if (terminalError !== void 0) throw terminalError;
    const blocks = assembler.blocks();
    const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join(" ").trim();
    return { text, finishKind: assembler.finish.kind };
  } catch (_) {
    var _error = _, _hasError = true;
  } finally {
    __callDispose(_stack, _error, _hasError);
  }
}
function finishError(finish) {
  switch (finish.kind) {
    case "stop":
      return void 0;
    case "error":
    case "aborted": {
      const failure = finish.failure ?? { message: "unknown failure", code: "UNKNOWN" };
      const error = new Error(failure.message);
      error.code = failure.code;
      return error;
    }
    case "max-tokens": {
      const error = new Error("enpoi-context-keeper: summary output reached maxOutputTokens");
      error.code = MAX_TOKENS_CUT_CODE;
      return error;
    }
    case "tool-calls":
      return new Error("enpoi-context-keeper: summarizer unexpectedly requested a tool");
    default:
      return void 0;
  }
}
export {
  BoundedSessionCache,
  BriefService,
  CHECKPOINT_SOURCE,
  CheckpointService,
  Config,
  KEEPER_CACHE_CAP,
  KEEPER_MAX_OUTPUT_TOKENS,
  KEEPER_MESSAGE_KIND,
  KEEPER_MIN_BRIEF_CHARS,
  KEEPER_ROUTE_FAILURE_THRESHOLD,
  KEEPER_ROUTE_QUARANTINE_MS,
  PREFETCH_DEBOUNCE_MS,
  apply,
  buildTemplateCheckpoint,
  checkpointTelemetry,
  cleanKeeperProse,
  createBriefService,
  createCheckpointService,
  extractClaimsJsonArray,
  getBriefService,
  getCheckpointService,
  getKeeperBookkeeping,
  inject,
  keeperAttempts,
  keeperBriefShapeRejection,
  keeperProseRejection,
  keeperRouteQuarantineRemaining,
  keeperRouteRequestLevelFailure,
  latestCheckpoint,
  latestCheckpointMessageSeq,
  name,
  renderCheckpointBlock,
  resetKeeperRouteHealth,
  resolveKeeperParams,
  resolveKeeperRoute,
  splitClaims,
  summarize
};
