// src/index.ts
import Schema from "@deepseek-ai/schemastery";

// src/config.ts
var MEMORY_CONFIG_DEFAULTS = {
  compactionFacts: true,
  compactionFactsIncludeChildSessions: false,
  compactionFactsMax: 12,
  compactionFactsNearDuplicate: 0.8,
  scopeCompactionFactsToWorkspace: true
};
function clamp(value, fallback, min, max) {
  return typeof value === "number" && !Number.isNaN(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
function resolveMemoryConfig(config) {
  const d = MEMORY_CONFIG_DEFAULTS;
  return {
    compactionFacts: typeof config?.compactionFacts === "boolean" ? config.compactionFacts : d.compactionFacts,
    compactionFactsIncludeChildSessions: typeof config?.compactionFactsIncludeChildSessions === "boolean" ? config.compactionFactsIncludeChildSessions : d.compactionFactsIncludeChildSessions,
    compactionFactsMax: Math.trunc(clamp(config?.compactionFactsMax, d.compactionFactsMax, 1, 40)),
    compactionFactsNearDuplicate: clamp(config?.compactionFactsNearDuplicate, d.compactionFactsNearDuplicate, 0.5, 1),
    scopeCompactionFactsToWorkspace: typeof config?.scopeCompactionFactsToWorkspace === "boolean" ? config.scopeCompactionFactsToWorkspace : d.scopeCompactionFactsToWorkspace
  };
}

// src/compaction-facts.ts
import {
  parseDurableFacts
} from "@deepseek-ai/dsh-compaction-basic/durable-facts";

// src/retriever.ts
import { readOrchestrationDocument } from "dsh-enpoi-contracts";
var MEMORY_PARAM_DEFAULTS = {
  retrieverTopK: 10,
  retrieverCharBudget: 1200
};
function getMemoryParams(ctx) {
  const d = MEMORY_PARAM_DEFAULTS;
  try {
    const settings = ctx?.get?.("settings");
    const doc = readOrchestrationDocument(settings);
    const p = doc?.parameters?.memory;
    if (p === void 0 || typeof p !== "object") return d;
    const clamp2 = (v, fallback, min, max) => typeof v === "number" && !Number.isNaN(v) ? Math.min(max, Math.max(min, v)) : fallback;
    return {
      retrieverTopK: clamp2(p.retrieverTopK, d.retrieverTopK, 1, 20),
      retrieverCharBudget: clamp2(p.retrieverCharBudget, d.retrieverCharBudget, 200, 4e3)
    };
  } catch {
    return d;
  }
}
function getOriginWeight(origin, trust) {
  if (trust === "operator" || origin === "orchestrator") return 1.5;
  if (origin.startsWith("worker")) return 1.2;
  if (origin === "keeper") return 1;
  if (origin === "legacy") return 1;
  return 1;
}
var CATEGORY_BOOST = {
  RULES: 1.4,
  CONSTRAINTS: 1.3,
  ARCHITECTURE: 1.2,
  NAMING: 1.1,
  CONFIG_VALUES: 1,
  PROJECT: 0.9
};
function compactionScopeClause(scope) {
  if (scope === void 0 || !scope.scopeCompaction) return { sql: "", params: [] };
  return {
    sql: `(c.origin != 'compaction' OR (json_valid(c.provenance) AND json_extract(c.provenance, '$.cwd') = ?))`,
    params: [scope.cwd ?? ""]
  };
}
function sanitizeFtsQuery(query) {
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).map((t) => t.trim()).filter((t) => t.length >= 2);
  if (terms.length === 0) return "";
  return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" AND ");
}
function tokenSet(text) {
  return new Set(
    text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).map((t) => t.trim()).filter((t) => t.length >= 2)
  );
}
function jaccard(left, right) {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}
function ftsRows(db, match, scope) {
  const filter = compactionScopeClause(scope);
  return db.prepare(`
    SELECT c.*, bm25(claims_fts) AS rank
    FROM claims_fts JOIN claims c ON c.rowid = claims_fts.rowid
    WHERE claims_fts MATCH ? AND c.state IN ('committed','tentative')${filter.sql === "" ? "" : ` AND ${filter.sql}`}
    ORDER BY rank LIMIT 20
  `).all(match, ...filter.params);
}
function searchMemory(db, query, limit = 10, scope) {
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).map((t) => t.trim()).filter((t) => t.length >= 2);
  const match = sanitizeFtsQuery(query);
  if (match === "") return [];
  let rows = ftsRows(db, match, scope);
  if (rows.length === 0 && terms.length > 1) {
    const orMatch = terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
    rows = ftsRows(db, orMatch, scope);
  }
  return rows.map((r) => ({
    ...r,
    score: -r.rank * getOriginWeight(r.origin, r.source_trust) * (CATEGORY_BOOST[r.category] ?? 1)
  })).sort((a, b) => b.score - a.score).slice(0, limit);
}
function nearDuplicateCandidates(db, fact, scope) {
  const terms = [...tokenSet(fact)];
  if (terms.length === 0) return [];
  const match = terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
  const filter = compactionScopeClause(scope);
  try {
    const rows = db.prepare(`
      SELECT c.fact FROM claims_fts JOIN claims c ON c.rowid = claims_fts.rowid
      WHERE claims_fts MATCH ? AND c.state IN ('committed','tentative')${filter.sql === "" ? "" : ` AND ${filter.sql}`}
      ORDER BY c.created_at DESC LIMIT 50
    `).all(match, ...filter.params);
    return rows.map((row) => row.fact);
  } catch {
    return [];
  }
}

// src/secret-guard.ts
var SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}/u,
  /\bghp_[A-Za-z0-9]{16,}/u,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/u,
  /\bBearer\s+\S{12,}/iu,
  /(?<=(?:api(?:_|-)?key|token|secret|password|passwd|authorization)"?\s*[=:]\s*"?)[^\s,;'"]{6,}/iu
];
function containsSecret(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  try {
    return SECRET_PATTERNS.some((pattern) => pattern.test(text));
  } catch {
    return false;
  }
}

// src/compaction-facts.ts
var CATEGORY_BY_KIND = {
  decision: "ARCHITECTURE",
  constraint: "PROJECT",
  requirement: "PROJECT",
  fact: "PROJECT"
};
function summaryText(summary) {
  if (!Array.isArray(summary)) return "";
  let text = "";
  for (const block of summary) {
    if (block !== null && typeof block === "object" && block.type === "text") {
      const value = block.text;
      if (typeof value === "string") text += value;
    }
  }
  return text;
}
function keyOf(sessionId, compactionId) {
  return `${sessionId}\0${compactionId}`;
}
function registerCompactionFacts(ctx, db, pipeline, config) {
  const held = /* @__PURE__ */ new Map();
  const warned = /* @__PURE__ */ new Set();
  let disposed = false;
  const warnOnce = (key, detail) => {
    if (warned.has(key)) return;
    warned.add(key);
    try {
      const message = detail instanceof Error ? detail.message : String(detail);
      ctx.logger?.warn(`enpoi-memory: compaction facts for ${key.replace("\0", "/")} skipped: ${message}`);
    } catch {
    }
  };
  const write = async (record) => {
    const key = keyOf(record.sessionId, record.compactionId);
    try {
      if (disposed) return;
      const scope = { cwd: record.cwd, scopeCompaction: config.scopeCompactionFactsToWorkspace };
      const threshold = config.compactionFactsNearDuplicate;
      const accepted = [];
      for (const fact of record.facts) {
        if (containsSecret(fact.text)) continue;
        if (accepted.some((claim) => jaccard(claim.fact, fact.text) >= threshold)) continue;
        const existing = nearDuplicateCandidates(db, fact.text, scope);
        if (existing.some((text) => jaccard(text, fact.text) >= threshold)) continue;
        accepted.push({ fact: fact.text, category: CATEGORY_BY_KIND[fact.kind], tags: `compaction ${fact.kind}` });
      }
      if (accepted.length === 0) return;
      const provenance = JSON.stringify({
        source: "compaction",
        sessionId: record.sessionId,
        compactionId: record.compactionId,
        cwd: record.cwd,
        shadowedRange: { start: record.shadowedRange.start, end: record.shadowedRange.end },
        summaryRoute: `${record.provider}/${record.model}`
      });
      const options = { origin: "compaction", trust: "verified_execution", provenance };
      await pipeline.intake(accepted, options);
    } catch (error) {
      warnOnce(key, error);
    }
  };
  const onSummary = (session, event) => {
    if (!config.compactionFacts) return;
    const data = event.data;
    if (data.provider === "") return;
    if (data.summarizationFailure !== void 0) return;
    if (session.header.parentSession !== void 0 && !config.compactionFactsIncludeChildSessions) return;
    const facts = parseDurableFacts(summaryText(data.summary)).slice(0, config.compactionFactsMax);
    if (facts.length === 0) return;
    held.set(keyOf(session.id, data.compactionId), {
      sessionId: session.id,
      compactionId: data.compactionId,
      cwd: session.header.cwd ?? "",
      shadowedRange: { start: data.shadowedRange.start, end: data.shadowedRange.end },
      provider: data.provider,
      model: data.model,
      facts
    });
  };
  const onEnd = (session, event) => {
    const key = keyOf(session.id, event.data.compactionId);
    const record = held.get(key);
    if (record === void 0) return;
    held.delete(key);
    if (event.data.error !== void 0) return;
    setImmediate(() => {
      void write(record);
    });
  };
  ctx.on("session/event", (session, event) => {
    try {
      if (event.type === "compaction/summary") onSummary(session, event);
      else if (event.type === "compaction/end") onEnd(session, event);
    } catch (error) {
      let key = "unknown";
      try {
        const compactionId = event.data?.compactionId;
        key = keyOf(session.id, String(compactionId ?? "unknown"));
      } catch {
      }
      warnOnce(key, error);
    }
  });
  ctx.on("session/disposed", (session) => {
    const prefix = `${session.id}\0`;
    for (const key of held.keys()) if (key.startsWith(prefix)) held.delete(key);
  });
  return () => {
    disposed = true;
    held.clear();
  };
}

// src/db.ts
import { DatabaseSync } from "node:sqlite";
import * as os from "node:os";
import * as path from "node:path";
var CATEGORIES = ["RULES", "ARCHITECTURE", "CONSTRAINTS", "CONFIG_VALUES", "NAMING", "PROJECT"];
var KEEPER_ALLOWED = /* @__PURE__ */ new Set(["ARCHITECTURE", "CONFIG_VALUES", "PROJECT"]);
var AUTOMATED_ORIGINS = /* @__PURE__ */ new Set(["keeper", "compaction"]);
function memoryDbPath() {
  return process.env.DSH_MEMORY_DB ?? path.join(os.homedir(), ".dsh", "memory.db");
}
var SCHEMA = `
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  fact TEXT NOT NULL,
  category TEXT NOT NULL,
  tags TEXT DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('tentative','committed','orphaned_cancelled','rescinded')),
  source_trust TEXT NOT NULL CHECK (source_trust IN ('operator','verified_execution','untrusted_external')),
  origin TEXT NOT NULL,
  provenance TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  committed_at INTEGER,
  supersedes TEXT,
  tombstone_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_claims_state ON claims(state);
CREATE INDEX IF NOT EXISTS idx_claims_category ON claims(category);

CREATE VIRTUAL TABLE IF NOT EXISTS claims_fts USING fts5(
  fact, content='claims', content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS claims_ai AFTER INSERT ON claims BEGIN
  INSERT INTO claims_fts(rowid, fact) VALUES (new.rowid, new.fact);
END;
CREATE TRIGGER IF NOT EXISTS claims_ad AFTER DELETE ON claims BEGIN
  INSERT INTO claims_fts(claims_fts, rowid, fact) VALUES ('delete', old.rowid, old.fact);
END;
CREATE TRIGGER IF NOT EXISTS claims_au AFTER UPDATE ON claims BEGIN
  INSERT INTO claims_fts(claims_fts, rowid, fact) VALUES ('delete', old.rowid, old.fact);
  INSERT INTO claims_fts(rowid, fact) VALUES (new.rowid, new.fact);
END;
`;
function openMemoryDb() {
  const db = new DatabaseSync(memoryDbPath());
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA busy_timeout=5000;");
  db.exec(SCHEMA);
  return db;
}

// src/pipeline.ts
import { createHash } from "node:crypto";
var FACT_CAP = 400;
function claimHash(fact, category) {
  return createHash("sha256").update(`${fact}::${category}`).digest("hex").slice(0, 12);
}
var Mutex = class {
  chain = Promise.resolve();
  run(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => void 0, () => void 0);
    return run;
  }
};
function makePipeline(db) {
  const mutex = new Mutex();
  function txn(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
      }
      throw err;
    }
  }
  function get(id) {
    return db.prepare("SELECT * FROM claims WHERE id = ?").get(id);
  }
  function stateOf(id) {
    return get(id)?.state;
  }
  async function intake(claims, opts) {
    return mutex.run(() => {
      const inserted = [];
      txn(() => {
        for (const c of claims) {
          const fact = String(c.fact ?? "").trim();
          if (fact.length === 0 || fact.length > FACT_CAP) continue;
          let category = String(c.category ?? "PROJECT").toUpperCase();
          if (!CATEGORIES.includes(category)) category = "PROJECT";
          if (AUTOMATED_ORIGINS.has(opts.origin) && !KEEPER_ALLOWED.has(category)) category = "PROJECT";
          const hash = claimHash(fact, category);
          const existing = db.prepare("SELECT * FROM claims WHERE id = ?").get(`claim-${hash}`);
          if (existing !== void 0) {
            if (existing.state === "rescinded") {
              continue;
            }
            if (opts.trust === "operator" && existing.state !== "committed") {
              db.prepare(`UPDATE claims SET state = 'committed', source_trust = 'operator', origin = ?, committed_at = ? WHERE id = ?`).run(opts.origin, Date.now(), existing.id);
              inserted.push(get(existing.id));
              continue;
            }
            if (existing.state === "orphaned_cancelled" && opts.trust === "verified_execution" && opts.parentAborted !== true) {
              db.prepare(`UPDATE claims SET state = 'committed', source_trust = ?, origin = ?, committed_at = ? WHERE id = ?`).run(opts.trust, opts.origin, Date.now(), existing.id);
              inserted.push(get(existing.id));
              continue;
            }
            continue;
          }
          const owner = db.prepare(
            `SELECT id FROM claims WHERE fact = ? AND state = 'committed' AND source_trust = 'operator' LIMIT 1`
          ).get(fact);
          if (owner !== void 0 && opts.trust !== "operator") {
            continue;
          }
          const state = opts.parentAborted ? "orphaned_cancelled" : opts.trust === "untrusted_external" ? "tentative" : "committed";
          const now = Date.now();
          db.prepare(
            `INSERT INTO claims (id, fact, category, tags, state, source_trust, origin, provenance, created_at, committed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            `claim-${hash}`,
            fact,
            category,
            c.tags ?? "",
            state,
            opts.trust === "verified_execution" || opts.trust === "operator" ? opts.trust : "untrusted_external",
            opts.origin,
            opts.provenance ?? "",
            now,
            state === "committed" ? now : null
          );
          inserted.push(get(`claim-${hash}`));
        }
      });
      return inserted;
    });
  }
  async function graduate(id) {
    return mutex.run(() => {
      let out = null;
      txn(() => {
        const row = get(id);
        if (row === void 0 || row.state !== "tentative") return;
        db.prepare(`UPDATE claims SET state = 'committed', committed_at = ? WHERE id = ?`).run(Date.now(), id);
        out = get(id) ?? null;
      });
      return out;
    });
  }
  async function confirm(id) {
    const row = get(id);
    if (row === void 0) return null;
    return graduate(id);
  }
  async function rescind(id, reason) {
    return mutex.run(() => {
      let changed = false;
      txn(() => {
        const row = get(id);
        if (row === void 0) return;
        db.prepare(`UPDATE claims SET state = 'rescinded', tombstone_reason = ? WHERE id = ?`).run(reason ?? "", id);
        changed = true;
      });
      return changed;
    });
  }
  async function reconcileBoot() {
    return mutex.run(() => {
      let n = 0;
      txn(() => {
        const res = db.prepare(`UPDATE claims SET state = 'orphaned_cancelled' WHERE state = 'tentative'`).run();
        n = Number(res?.changes ?? 0);
      });
      return n;
    });
  }
  function list(filter) {
    if (filter?.category !== void 0 && filter?.state !== void 0) {
      return db.prepare(`SELECT * FROM claims WHERE category = ? AND state = ? ORDER BY created_at DESC, rowid DESC`).all(filter.category, filter.state);
    }
    if (filter?.category !== void 0) {
      return db.prepare(`SELECT * FROM claims WHERE category = ? ORDER BY created_at DESC, rowid DESC`).all(filter.category);
    }
    if (filter?.state !== void 0) {
      return db.prepare(`SELECT * FROM claims WHERE state = ? ORDER BY created_at DESC, rowid DESC`).all(filter.state);
    }
    return db.prepare(`SELECT * FROM claims ORDER BY created_at DESC, rowid DESC LIMIT 200`).all();
  }
  return { intake, graduate, confirm, rescind, reconcileBoot, list, get, stateOf };
}

// src/tools.ts
function savedAt(claim) {
  const stamp = claim.committed_at ?? claim.created_at;
  const date = new Date(stamp);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}
function registerMemoryTools(ctx, db, pipeline, config = resolveMemoryConfig(void 0)) {
  ctx.tools.register({
    name: "memory_save",
    description: [
      "Save a durable project fact to cross-session memory.",
      "Use for: project rules, architecture decisions, constraints, config values, naming conventions,",
      "facts a FUTURE session must know. The fact is stored with operator trust (authoritative).",
      "Keep it short (\u2264400 chars) and self-contained."
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        fact: { type: "string", description: "The durable fact (\u2264400 chars, self-contained, no fluff)" },
        category: { type: "string", enum: [...CATEGORIES], description: "RULES | ARCHITECTURE | CONSTRAINTS | CONFIG_VALUES | NAMING | PROJECT" },
        tags: { type: "string", description: "Optional space-separated keywords" }
      },
      required: ["fact", "category"]
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { saved: { type: "boolean" }, id: { type: "string" }, state: { type: "string" }, note: { type: "string" } },
        required: ["saved"]
      },
      render: (_a, raw) => {
        const v = raw;
        return [{ type: "text", text: v.saved ? `Memory saved: ${String(v.id)} (${String(v.state)})` : `Memory NOT saved \u2014 ${String(v.note ?? "")}` }];
      }
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = exec?.agent?.session;
      const provenance = JSON.stringify({
        source: "memory_save",
        sessionId: session?.id ?? "",
        cwd: session?.header.cwd ?? ""
      });
      const inserted = await pipeline.intake(
        [{ fact: String(args.fact ?? ""), category: String(args.category ?? "PROJECT"), tags: String(args.tags ?? "") }],
        { origin: "orchestrator", trust: "operator", provenance }
      );
      if (inserted.length === 0) return { saved: false, note: "Duplicate or invalid fact (already known / empty / >400 chars)" };
      const c = inserted[0];
      return { saved: true, id: c.id, state: c.state, note: `Saved as ${c.id} (${c.category})` };
    }
  });
  ctx.tools.register({
    name: "memory_search",
    description: "Search cross-session memory for facts relevant to a query. Returns matching facts (never injects).",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you are looking for \u2014 natural language or keywords" },
        limit: { type: "number", description: "Max results (default 8, max 10)" }
      },
      required: ["query"]
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          facts: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                category: { type: "string" },
                origin: { type: "string" },
                savedAt: { type: "string" },
                state: { type: "string" },
                trust: { type: "string" },
                fact: { type: "string" }
              },
              required: ["id", "fact"]
            }
          },
          note: { type: "string" }
        },
        required: ["facts"]
      },
      // C4: `• <id> <category> [<origin> <savedAt>] — <fact>`.
      render: (_a, raw) => {
        const v = raw;
        return [{
          type: "text",
          text: (Array.isArray(v.facts) ? v.facts.map((f) => `\u2022 ${f.id} ${f.category} [${f.origin} ${f.savedAt}] \u2014 ${f.fact}`) : []).join("\n") || "No matching memory."
        }];
      }
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const params = getMemoryParams(ctx);
      const scope = { cwd: exec?.agent?.session.header.cwd, scopeCompaction: config.scopeCompactionFactsToWorkspace };
      const hits = searchMemory(db, String(args.query ?? ""), Math.min(Number(args.limit ?? params.retrieverTopK) || params.retrieverTopK, params.retrieverTopK), scope);
      if (hits.length === 0) return { facts: [], note: "No matching memory." };
      return {
        facts: hits.map((h) => ({
          id: h.id,
          category: h.category,
          origin: h.origin,
          savedAt: savedAt(h),
          state: h.state,
          trust: h.source_trust,
          fact: h.fact
        })),
        note: `${hits.length} fact(s)`
      };
    }
  });
  ctx.tools.register({
    name: "memory_rescind",
    description: "Retract a saved memory fact (tombstone \u2014 it will never be injected into future turns).",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The fact id (e.g. claim-a1b2...) from memory_search or memory_save" },
        reason: { type: "string", description: "Optional reason for the record" }
      },
      required: ["id"]
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { rescinded: { type: "boolean" }, note: { type: "string" } },
        required: ["rescinded"]
      },
      render: (_a, raw) => {
        const v = raw;
        return [{ type: "text", text: v.rescinded ? "Memory fact rescinded (tombstoned)." : String(v.note ?? "Not rescinded.") }];
      }
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const ok = await pipeline.rescind(String(args.id ?? ""), String(args.reason ?? ""));
      return ok ? { rescinded: true } : { rescinded: false, note: `No active fact with id ${String(args.id)}` };
    }
  });
  ctx.tools.register({
    name: "memory_confirm",
    description: "Explicitly confirm/graduate a tentative (untrusted) memory fact after verifying it. Operator action \u2014 use only on facts you or the operator verified. Facts saved with memory_save are already committed; confirmation applies to tentative chat-sourced claims.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The tentative fact id" }
      },
      required: ["id"]
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { confirmed: { type: "boolean" }, id: { type: "string" }, state: { type: "string" }, note: { type: "string" } },
        required: ["confirmed"]
      },
      render: (_a, raw) => {
        const v = raw;
        return [{ type: "text", text: v.confirmed ? `Memory confirmed: ${String(v.id)} \u2192 ${String(v.state)}` : String(v.note ?? "Not confirmed.") }];
      }
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const id = String(args.id ?? "");
      const row = await pipeline.confirm(id);
      if (row !== null) return { confirmed: true, id: row.id, state: row.state };
      const existing = pipeline.get(id);
      if (existing !== void 0) {
        return {
          confirmed: false,
          id: existing.id,
          state: existing.state,
          note: `Already ${existing.state}; confirmation applies only to tentative facts.`
        };
      }
      return { confirmed: false, note: `Unknown fact id "${id}".` };
    }
  });
}

// src/index.ts
var name = "enpoi-memory";
var inject = ["tools"];
var Config = Schema.object({
  compactionFacts: Schema.boolean().default(true),
  compactionFactsIncludeChildSessions: Schema.boolean().default(false),
  compactionFactsMax: Schema.natural().min(1).max(40).default(12),
  compactionFactsNearDuplicate: Schema.number().step(0.01).min(0.5).max(1).default(0.8),
  scopeCompactionFactsToWorkspace: Schema.boolean().default(true)
});
function apply(ctx, config = {}) {
  const cfg = resolveMemoryConfig(config);
  const db = openMemoryDb();
  const pipeline = makePipeline(db);
  void pipeline.reconcileBoot().then((n) => {
    if (n > 0) ctx.logger?.warn(`enpoi-memory: boot reconciled ${n} tentative claim(s) \u2192 orphaned_cancelled`);
  });
  registerMemoryTools(ctx, db, pipeline, cfg);
  if (cfg.compactionFacts) ctx.effect(() => registerCompactionFacts(ctx, db, pipeline, cfg));
}
export {
  Config,
  MEMORY_CONFIG_DEFAULTS,
  apply,
  inject,
  makePipeline,
  name,
  openMemoryDb,
  resolveMemoryConfig
};
