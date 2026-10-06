var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __knownSymbol = (name2, symbol) => (symbol = Symbol[name2]) ? symbol : Symbol.for("Symbol." + name2);
var __typeError = (msg) => {
  throw TypeError(msg);
};
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __decoratorStart = (base) => [, , , __create(base?.[__knownSymbol("metadata")] ?? null)];
var __decoratorStrings = ["class", "method", "getter", "setter", "accessor", "field", "value", "get", "set"];
var __expectFn = (fn) => fn !== void 0 && typeof fn !== "function" ? __typeError("Function expected") : fn;
var __decoratorContext = (kind, name2, done, metadata, fns) => ({ kind: __decoratorStrings[kind], name: name2, metadata, addInitializer: (fn) => done._ ? __typeError("Already initialized") : fns.push(__expectFn(fn || null)) });
var __decoratorMetadata = (array, target) => __defNormalProp(target, __knownSymbol("metadata"), array[3]);
var __runInitializers = (array, flags, self, value) => {
  for (var i = 0, fns = array[flags >> 1], n = fns && fns.length; i < n; i++) flags & 1 ? fns[i].call(self) : value = fns[i].call(self, value);
  return value;
};
var __decorateElement = (array, flags, name2, decorators, target, extra) => {
  var fn, it, done, ctx, access, k = flags & 7, s = !!(flags & 8), p = !!(flags & 16);
  var j = k > 3 ? array.length + 1 : k ? s ? 1 : 2 : 0, key = __decoratorStrings[k + 5];
  var initializers = k > 3 && (array[j - 1] = []), extraInitializers = array[j] || (array[j] = []);
  var desc = k && (!p && !s && (target = target.prototype), k < 5 && (k > 3 || !p) && __getOwnPropDesc(k < 4 ? target : { get [name2]() {
    return __privateGet(this, extra);
  }, set [name2](x) {
    return __privateSet(this, extra, x);
  } }, name2));
  k ? p && k < 4 && __name(extra, (k > 2 ? "set " : k > 1 ? "get " : "") + name2) : __name(target, name2);
  for (var i = decorators.length - 1; i >= 0; i--) {
    ctx = __decoratorContext(k, name2, done = {}, array[3], extraInitializers);
    if (k) {
      ctx.static = s, ctx.private = p, access = ctx.access = { has: p ? (x) => __privateIn(target, x) : (x) => name2 in x };
      if (k ^ 3) access.get = p ? (x) => (k ^ 1 ? __privateGet : __privateMethod)(x, target, k ^ 4 ? extra : desc.get) : (x) => x[name2];
      if (k > 2) access.set = p ? (x, y) => __privateSet(x, target, y, k ^ 4 ? extra : desc.set) : (x, y) => x[name2] = y;
    }
    it = (0, decorators[i])(k ? k < 4 ? p ? extra : desc[key] : k > 4 ? void 0 : { get: desc.get, set: desc.set } : target, ctx), done._ = 1;
    if (k ^ 4 || it === void 0) __expectFn(it) && (k > 4 ? initializers.unshift(it) : k ? p ? extra = it : desc[key] = it : target = it);
    else if (typeof it !== "object" || it === null) __typeError("Object expected");
    else __expectFn(fn = it.get) && (desc.get = fn), __expectFn(fn = it.set) && (desc.set = fn), __expectFn(fn = it.init) && initializers.unshift(fn);
  }
  return k || __decoratorMetadata(array, target), desc && __defProp(target, name2, desc), p ? k ^ 4 ? extra : desc : target;
};
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateIn = (member, obj) => Object(obj) !== obj ? __typeError('Cannot use the "in" operator on this value') : member.has(obj);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), setter ? setter.call(obj, value) : member.set(obj, value), value);
var __privateMethod = (obj, member, method) => (__accessCheck(obj, member, "access private method"), method);

// src/index.ts
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import Schema from "@deepseek-ai/schemastery";

// src/fingerprint.ts
import { createHash } from "node:crypto";
var MAX_NORMALIZED_CHARS = 400;
var UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
var HEX_ID_RE = /\b(?:0x)?[0-9a-f]{16,}\b/gi;
var ISO_TS_RE = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;
var DURATION_RE = /\b\d+(?:\.\d+)?\s?(?:milliseconds?|msec|minutes?|mins|min|seconds?|secs|sec|hours?|hrs|hr|ms|m|h|s)\b/gi;
var PATH_RE = /(?:[A-Za-z]:)?(?:[\\/](?:[\w.@+~-]+|\.{2})){2,}[\\/]?/g;
var NUMBER_RE = /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;
function normalizeMessage(input) {
  let text = String(input ?? "");
  try {
    text = text.normalize("NFKC");
  } catch {
  }
  text = text.replace(UUID_RE, "<uuid>").replace(HEX_ID_RE, "<hex>").replace(ISO_TS_RE, "<ts>").replace(DURATION_RE, "<dur>").replace(PATH_RE, "<path>").replace(NUMBER_RE, "<n>").replace(/\s+/g, " ").trim();
  return text.slice(0, MAX_NORMALIZED_CHARS);
}
function fingerprintMessage(subject, message) {
  const normalized = normalizeMessage(message);
  const digest = createHash("sha256").update(`${subject}\0${normalized}`).digest("hex");
  return {
    normalized,
    fingerprint: digest.slice(0, 16),
    code: `D${digest.slice(0, 6).toUpperCase()}`
  };
}

// src/store.ts
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
var SEVERITIES = ["debug", "info", "warn", "error", "fatal"];
var WINDOWS = ["1h", "24h", "7d", "all"];
var WINDOW_MS = {
  "1h": 36e5,
  "24h": 864e5,
  "7d": 6048e5
};
function severityRank(severity) {
  const rank = SEVERITIES.indexOf(severity);
  return rank < 0 ? 0 : rank;
}
function normalizeSeverity(value) {
  return typeof value === "string" && SEVERITIES.includes(value) ? value : "error";
}
var MAX_MESSAGE_CHARS = 500;
var MAX_CONTEXT_CHARS = 2e3;
var MAX_PATTERN_SOURCES = 8;
var SCHEMA = `
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  severity TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  code TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  message TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  session_id TEXT,
  provider TEXT,
  model TEXT,
  count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS incidents_fingerprint_at ON incidents(fingerprint, at);
CREATE INDEX IF NOT EXISTS incidents_at ON incidents(at);
CREATE INDEX IF NOT EXISTS incidents_source ON incidents(source);

CREATE TABLE IF NOT EXISTS patterns (
  fingerprint TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  count INTEGER NOT NULL,
  sample_message TEXT NOT NULL,
  sources TEXT NOT NULL DEFAULT '[]',
  severity_max TEXT NOT NULL,
  upgraded_at INTEGER,
  code TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  muted_at INTEGER
);
CREATE INDEX IF NOT EXISTS patterns_last_seen ON patterns(last_seen);
`;
function truncate(value, max) {
  const text = typeof value === "string" ? value : safeText(value);
  return text.length > max ? text.slice(0, max) : text;
}
function safeText(value) {
  if (value === null) return "null";
  if (value === void 0) return "undefined";
  const kind = typeof value;
  if (kind === "string") return value;
  if (kind === "number" || kind === "boolean" || kind === "bigint") return String(value);
  if (kind === "symbol") return value.toString();
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    const json = JSON.stringify(value);
    if (json !== void 0) return json;
  } catch {
  }
  try {
    return Object.prototype.toString.call(value);
  } catch {
    return "[unprintable]";
  }
}
function parseContext(json) {
  try {
    const parsed = JSON.parse(json);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function serializeContext(context) {
  try {
    const json = JSON.stringify(context ?? {});
    return json.length > MAX_CONTEXT_CHARS ? `${json.slice(0, MAX_CONTEXT_CHARS - 12)}\u2026"}` : json;
  } catch {
    return "{}";
  }
}
var IncidentStore = class {
  /** Resolved database path (the surface reports it verbatim). */
  path;
  db;
  maxIncidents;
  maxPatterns;
  cooldownMs;
  now;
  /** Open cooldown buckets by fingerprint: the row that a repeat bumps. */
  buckets = /* @__PURE__ */ new Map();
  closed = false;
  selectPattern;
  insertPattern;
  updatePattern;
  selectIncidentTail;
  insertIncident;
  bumpIncident;
  countIncidents;
  countPatterns;
  /**
   * @param path - absolute SQLite path; missing parent directories are created.
   * @param options - caps, cooldown, and an optional test clock.
   */
  constructor(path, options = {}) {
    this.path = path;
    this.maxIncidents = Math.max(1, Math.trunc(options.maxIncidents ?? 5e3));
    this.maxPatterns = Math.max(1, Math.trunc(options.maxPatterns ?? 2e3));
    this.cooldownMs = Math.max(0, Math.trunc(options.cooldownMs ?? 3e5));
    this.now = options.now ?? Date.now;
    mkdirSync(dirname(path), { recursive: true, mode: 448 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA busy_timeout=3000;");
    this.db.exec(SCHEMA);
    this.selectPattern = this.db.prepare("SELECT * FROM patterns WHERE fingerprint = ?");
    this.insertPattern = this.db.prepare(
      "INSERT INTO patterns (fingerprint, first_seen, last_seen, count, sample_message, sources, severity_max, upgraded_at, code, kind) VALUES (?, ?, ?, 1, ?, ?, ?, NULL, ?, ?)"
    );
    this.updatePattern = this.db.prepare(
      "UPDATE patterns SET first_seen = ?, last_seen = ?, count = ?, sample_message = ?, sources = ?, severity_max = ?, upgraded_at = ? WHERE fingerprint = ?"
    );
    this.selectIncidentTail = this.db.prepare("SELECT id, at FROM incidents WHERE fingerprint = ? ORDER BY id DESC LIMIT 1");
    this.insertIncident = this.db.prepare(
      "INSERT INTO incidents (at, severity, source, kind, code, fingerprint, message, context_json, session_id, provider, model, count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)"
    );
    this.bumpIncident = this.db.prepare("UPDATE incidents SET count = count + 1 WHERE id = ?");
    this.countIncidents = this.db.prepare("SELECT COUNT(*) AS n FROM incidents");
    this.countPatterns = this.db.prepare("SELECT COUNT(*) AS n FROM patterns");
  }
  /** Whether the store is still open (a closed store rejects writes). */
  get isOpen() {
    return !this.closed;
  }
  /**
   * Record one incident: upsert the pattern rollup, then either bump the open
   * cooldown bucket's row or open a new one.
   *
   * @param input - the incident to store.
   * @returns the fingerprint, code, and whether the row was aggregated.
   */
  record(input) {
    if (this.closed) throw new Error("diagnostics store is closed");
    const at = input.at ?? this.now();
    const severity = normalizeSeverity(input.severity);
    const message = truncate(input.message, MAX_MESSAGE_CHARS);
    const code = truncate(input.code, 60) || severity.toUpperCase();
    const kind = truncate(input.kind, 60) || "unknown";
    const fingerprint = truncate(input.fingerprint, 64) || fingerprintMessage(kind, message).fingerprint;
    const source = truncate(input.source, 120) || "unknown";
    this.db.exec("BEGIN IMMEDIATE");
    let aggregated = false;
    try {
      this.upsertPattern({ at, severity, source, kind, code, fingerprint, message });
      const open = this.buckets.get(fingerprint) ?? this.tailBucket(fingerprint);
      if (open !== void 0 && at >= open.at && at - open.at < this.cooldownMs) {
        this.bumpIncident.run(open.id);
        this.buckets.set(fingerprint, open);
        aggregated = true;
      } else {
        const info = this.insertIncident.run(
          at,
          severity,
          source,
          kind,
          code,
          fingerprint,
          message,
          serializeContext(input.context),
          input.sessionId ?? null,
          input.provider ?? null,
          input.model ?? null
        );
        this.buckets.set(fingerprint, { id: Number(info.lastInsertRowid), at });
      }
      this.enforceCaps();
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
      }
      throw error;
    }
    return { fingerprint, code, aggregated };
  }
  /** Record a batch in one transaction (the queue flush path). */
  recordMany(inputs) {
    let stored = 0;
    for (const input of inputs) {
      this.record(input);
      stored += 1;
    }
    return stored;
  }
  /** Read pattern rollups ordered by most recent activity. */
  patterns(query = {}) {
    if (this.closed) return [];
    const window = query.window ?? "all";
    const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? 50)), 500);
    const minCount = Math.max(1, Math.trunc(query.minCount ?? 1));
    const since = window === "all" ? Number.MIN_SAFE_INTEGER : this.now() - WINDOW_MS[window];
    const rows = this.db.prepare(
      `SELECT p.*, COALESCE((SELECT SUM(i.count) FROM incidents i WHERE i.fingerprint = p.fingerprint AND i.at >= ?), 0) AS window_count
       FROM patterns p
       WHERE (? = 1 OR p.muted_at IS NULL)
         AND p.count >= ?
         AND (? IS NULL OR p.kind = ?)
       ORDER BY p.last_seen DESC
       LIMIT ?`
    ).all(since, query.includeMuted === true ? 1 : 0, minCount, query.kind ?? null, query.kind ?? null, limit);
    return rows.map((row) => this.toPatternRow(row, row.window_count));
  }
  /** Read recent incident rows ordered by insertion (newest first). */
  incidents(query = {}) {
    if (this.closed) return [];
    const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? 50)), 500);
    const clauses = [];
    const args = [];
    if (query.since !== void 0) {
      clauses.push("i.at >= ?");
      args.push(Math.trunc(query.since));
    }
    if (query.severity !== void 0 && query.severity !== "all") {
      clauses.push("i.severity = ?");
      args.push(normalizeSeverity(query.severity));
    }
    if (query.source !== void 0) {
      clauses.push("i.source = ?");
      args.push(truncate(query.source, 120));
    }
    if (query.kind !== void 0) {
      clauses.push("i.kind = ?");
      args.push(truncate(query.kind, 60));
    }
    if (query.fingerprint !== void 0) {
      clauses.push("i.fingerprint = ?");
      args.push(truncate(query.fingerprint, 64));
    }
    if (query.includeMuted !== true) {
      clauses.push("i.fingerprint NOT IN (SELECT fingerprint FROM patterns WHERE muted_at IS NOT NULL)");
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(
      `SELECT i.* FROM incidents i ${where} ORDER BY i.id DESC LIMIT ?`
    ).all(...args, limit);
    return rows.map((row) => this.toIncidentRow(row));
  }
  /** Per-source occurrence breakdown for the operator report. */
  sources(limit = 20) {
    if (this.closed) return [];
    const rows = this.db.prepare(
      "SELECT source, SUM(count) AS count, MAX(at) AS last_seen FROM incidents GROUP BY source ORDER BY count DESC LIMIT ?"
    ).all(Math.min(Math.max(1, Math.trunc(limit)), 100));
    return rows.map((row) => ({ source: row.source, count: row.count, lastSeen: row.last_seen }));
  }
  /** Mute or unmute one pattern. Returns the resulting state (unknown fingerprints stay unmuted). */
  mute(fingerprint, muted = true) {
    if (this.closed) return { ok: false, muted: false, note: "store closed" };
    const key = truncate(fingerprint, 64);
    const result = this.db.prepare("UPDATE patterns SET muted_at = ? WHERE fingerprint = ?").run(muted ? this.now() : null, key);
    if (result.changes === 0) return { ok: false, muted: false, note: "unknown fingerprint" };
    return { ok: true, muted };
  }
  /** Store counters for surfaces. */
  stats() {
    if (this.closed) {
      return { path: this.path, incidents: 0, patterns: 0, muted: 0, maxIncidents: this.maxIncidents, maxPatterns: this.maxPatterns, cooldownMs: this.cooldownMs };
    }
    const incidents = Number(this.countIncidents.get()?.n ?? 0);
    const patterns = Number(this.countPatterns.get()?.n ?? 0);
    const muted = Number(this.db.prepare("SELECT COUNT(*) AS n FROM patterns WHERE muted_at IS NOT NULL").get()?.n ?? 0);
    return { path: this.path, incidents, patterns, muted, maxIncidents: this.maxIncidents, maxPatterns: this.maxPatterns, cooldownMs: this.cooldownMs };
  }
  /** Close the connection; further writes throw and reads return empty. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.buckets.clear();
    try {
      this.db.close();
    } catch {
    }
  }
  /** Read-modify-write one pattern row inside the caller's transaction. */
  upsertPattern(input) {
    const previous = this.selectPattern.get(input.fingerprint);
    if (previous === void 0) {
      this.insertPattern.run(
        input.fingerprint,
        input.at,
        input.at,
        input.message,
        JSON.stringify([input.source]),
        input.severity,
        input.code,
        input.kind
      );
      return;
    }
    const sources = /* @__PURE__ */ new Set();
    try {
      const parsed = JSON.parse(previous.sources);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) if (typeof entry === "string") sources.add(entry);
      }
    } catch {
    }
    sources.add(input.source);
    const severityMax = severityRank(input.severity) > severityRank(normalizeSeverity(previous.severity_max)) ? input.severity : normalizeSeverity(previous.severity_max);
    const upgradedAt = severityMax !== normalizeSeverity(previous.severity_max) ? input.at : previous.upgraded_at;
    this.updatePattern.run(
      Math.min(previous.first_seen, input.at),
      Math.max(previous.last_seen, input.at),
      previous.count + 1,
      previous.sample_message === "" ? input.message : previous.sample_message,
      JSON.stringify([...sources].slice(-MAX_PATTERN_SOURCES)),
      severityMax,
      upgradedAt,
      input.fingerprint
    );
  }
  /** Resolve a fingerprint's open bucket from disk (after a restart). */
  tailBucket(fingerprint) {
    const row = this.selectIncidentTail.get(fingerprint);
    return row === void 0 ? void 0 : { id: row.id, at: row.at };
  }
  /** Evict the oldest incident rows and least-recently-seen patterns past their caps. */
  enforceCaps() {
    const incidentCount = Number(this.countIncidents.get()?.n ?? 0);
    if (incidentCount > this.maxIncidents) {
      this.db.prepare(
        "DELETE FROM incidents WHERE id IN (SELECT id FROM incidents ORDER BY id ASC LIMIT ?)"
      ).run(incidentCount - this.maxIncidents);
    }
    const patternCount = Number(this.countPatterns.get()?.n ?? 0);
    if (patternCount > this.maxPatterns) {
      this.db.prepare(
        "DELETE FROM patterns WHERE fingerprint IN (SELECT fingerprint FROM patterns WHERE muted_at IS NULL ORDER BY last_seen ASC LIMIT ?)"
      ).run(patternCount - this.maxPatterns);
    }
    if (this.buckets.size > this.maxPatterns * 2) this.buckets.clear();
  }
  toPatternRow(row, windowCount) {
    let sources = [];
    try {
      const parsed = JSON.parse(row.sources);
      if (Array.isArray(parsed)) sources = parsed.filter((entry) => typeof entry === "string");
    } catch {
      sources = [];
    }
    return {
      fingerprint: row.fingerprint,
      code: row.code,
      kind: row.kind,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      count: row.count,
      windowCount,
      sampleMessage: row.sample_message,
      sources,
      severityMax: normalizeSeverity(row.severity_max),
      upgradedAt: row.upgraded_at ?? null,
      muted: row.muted_at !== null
    };
  }
  toIncidentRow(row) {
    return {
      id: row.id,
      at: row.at,
      severity: normalizeSeverity(row.severity),
      source: row.source,
      kind: row.kind,
      code: row.code,
      fingerprint: row.fingerprint,
      message: row.message,
      context: parseContext(row.context_json),
      sessionId: row.session_id,
      provider: row.provider,
      model: row.model,
      count: row.count
    };
  }
};

// src/capture.ts
var FIBER_STATE_FAILED = 3;
var LOGGER_LEVEL_ALL = 3;
var IncidentBus = class {
  constructor(store, options = {}) {
    this.store = store;
    this.options = options;
    this.flushMs = Math.max(10, Math.trunc(options.flushMs ?? 250));
    this.queueLimit = Math.max(16, Math.trunc(options.queueLimit ?? 2e3));
  }
  pending = [];
  timer;
  flushing = false;
  disposed = false;
  failures = 0;
  drops = 0;
  stored = 0;
  queued = 0;
  selfNotified = false;
  flushMs;
  queueLimit;
  /** Queue one incident. Never throws; overflow is counted and dropped. */
  push(input) {
    if (this.disposed) return;
    try {
      this.pending.push({ ...input, message: truncate(input.message, 500) });
      this.queued += 1;
      if (this.pending.length >= this.queueLimit) {
        this.pending.splice(0, this.pending.length - this.queueLimit);
        this.drops += 1;
      }
      this.schedule();
    } catch {
      this.noteSelfFailure();
    }
  }
  /** Count one swallowed diagnostics failure (the single counter from doc 68 principles). */
  noteSelfFailure() {
    this.failures += 1;
    if (!this.selfNotified) {
      this.selfNotified = true;
      try {
        this.options.onSelfFailure?.();
      } catch {
        this.failures += 1;
      }
    }
  }
  /** Flush now (used before report reads and on dispose). Never throws. */
  flushNow() {
    if (this.timer !== void 0) {
      clearTimeout(this.timer);
      this.timer = void 0;
    }
    this.drain();
  }
  /** Stop the timer and flush what remains. */
  dispose() {
    this.disposed = true;
    this.flushNow();
    this.pending = [];
  }
  /** Read the capture counters. */
  stats() {
    return {
      queued: this.queued,
      stored: this.stored,
      dropped: this.drops + this.failures,
      selfFailures: this.failures,
      pending: this.pending.length
    };
  }
  schedule() {
    if (this.timer !== void 0 || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = void 0;
      this.drain();
    }, this.flushMs);
    this.timer.unref?.();
  }
  drain() {
    if (this.flushing || this.pending.length === 0) return;
    this.flushing = true;
    const batch = this.pending;
    this.pending = [];
    try {
      this.stored += this.store.recordMany(batch);
    } catch {
      this.failures += 1;
      this.drops += batch.length;
      if (!this.selfNotified) {
        this.selfNotified = true;
        try {
          this.options.onSelfFailure?.();
        } catch {
          this.failures += 1;
        }
      }
    } finally {
      this.flushing = false;
    }
    if (this.pending.length > 0) this.schedule();
  }
};
function logIncident(message) {
  const name2 = typeof message.name === "string" && message.name !== "" ? message.name : "root";
  if (name2.startsWith("enpoi-diagnostics")) return void 0;
  const severity = message.type === "error" || message.type === "warn" || message.type === "info" || message.type === "debug" ? message.type : "error";
  const text = formatLogArgs(message.args);
  if (text === "") return void 0;
  return {
    at: message.ts,
    severity,
    source: `log:${name2}`,
    kind: "log",
    ...fingerprintIncident(`log:${name2}`, text, { logger: name2, level: message.level, sn: message.sn })
  };
}
function formatLogArgs(args) {
  const parts = [];
  for (const arg of args.slice(0, 6)) {
    parts.push(formatValue(arg));
    if (parts.join(" ").length > 2e3) break;
  }
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 2e3);
}
function formatValue(value) {
  try {
    if (typeof value === "string") return value;
    if (value instanceof Error) {
      const head = `${value.name}: ${value.message}`;
      const frames = typeof value.stack === "string" ? value.stack.split("\n").slice(1, 3).map((line) => line.trim()).filter((line) => line !== "").join(" | ") : "";
      return frames === "" ? head : `${head} | ${frames}`;
    }
    if (value === null || value === void 0) return String(value);
    const kind = typeof value;
    if (kind === "number" || kind === "boolean" || kind === "bigint" || kind === "symbol") return String(value);
    const json = JSON.stringify(value);
    return json === void 0 ? Object.prototype.toString.call(value) : json.slice(0, 800);
  } catch {
    return "[unprintable]";
  }
}
function attachLoggerSink(ctx, bus, minSeverity = "debug") {
  const exporter = {
    levels: { default: LOGGER_LEVEL_ALL },
    export: (message) => {
      try {
        if (severityRank(message.type) < severityRank(minSeverity)) return;
        const incident = logIncident(message);
        if (incident !== void 0) bus.push(incident);
      } catch {
        bus.noteSelfFailure();
      }
    }
  };
  try {
    ctx.logger.exporter(exporter);
  } catch {
    bus.noteSelfFailure();
  }
}
var MAX_SESSION_CONTEXTS = 200;
var MAX_TOOL_CALLS = 500;
function attachSessionEvents(ctx, bus) {
  const sessions = /* @__PURE__ */ new Map();
  const tools = /* @__PURE__ */ new Map();
  const listener = (session, event) => {
    try {
      const id = session.id;
      const data = event.data ?? {};
      switch (event.type) {
        case "request/context": {
          rememberSession(sessions, id, {
            provider: typeof data.provider === "string" ? data.provider : void 0,
            model: typeof data.model === "string" ? data.model : void 0
          });
          return;
        }
        case "tool/call": {
          const callId = typeof data.callId === "string" ? data.callId : void 0;
          const name2 = typeof data.name === "string" ? data.name : "unknown";
          if (callId !== void 0) {
            tools.set(callId, name2);
            if (tools.size > MAX_TOOL_CALLS) tools.delete(tools.keys().next().value);
          }
          return;
        }
        case "tool/result": {
          const error = data.error;
          if (error === void 0 || error === null) return;
          const callId = typeof data.callId === "string" ? data.callId : void 0;
          const tool = callId !== void 0 ? tools.get(callId) ?? "unknown" : "unknown";
          const code = typeof error.code === "string" ? error.code : "TOOL_ERROR";
          const name2 = typeof error.name === "string" ? error.name : "ToolError";
          const reason = typeof error.reason === "string" ? error.reason : "";
          bus.push({
            ...sessionAttribution(sessions, id),
            severity: "error",
            source: "session",
            kind: "tool-error",
            ...fingerprintIncident(`tool-error:${tool}`, `${name2}: ${reason !== "" ? reason : code}`, {
              errorCode: code,
              tool,
              callId: callId ?? null,
              turn: data.turn ?? null,
              step: data.step ?? null
            })
          });
          return;
        }
        case "llm/retry": {
          const failure = data.failure;
          const code = typeof failure?.code === "string" ? failure.code : "LLM_RETRY";
          const text = typeof failure?.message === "string" && failure.message !== "" ? failure.message : `provider retry (${code})`;
          bus.push({
            ...sessionAttribution(sessions, id),
            severity: "warn",
            source: "session",
            kind: "provider-error",
            provider: typeof data.provider === "string" ? data.provider : void 0,
            ...fingerprintIncident("provider-error", text, {
              errorCode: code,
              retry: data.retry ?? null,
              maxRetries: data.maxRetries ?? null,
              mode: data.mode ?? null,
              policyKey: data.policyKey ?? null,
              turn: data.turn ?? null,
              step: data.step ?? null,
              delayMs: data.delayMs ?? null
            })
          });
          return;
        }
        case "turn/end": {
          const reason = data.reason;
          if (reason?.kind !== "error") return;
          const code = typeof reason.error?.code === "string" ? reason.error.code : "UNKNOWN";
          const text = typeof reason.error?.message === "string" && reason.error.message !== "" ? reason.error.message : `turn failed (${code})`;
          bus.push({
            ...sessionAttribution(sessions, id),
            severity: "error",
            source: "session",
            kind: "turn-error",
            provider: typeof data.provider === "string" ? data.provider : void 0,
            ...fingerprintIncident("turn-error", text, { errorCode: code, turn: data.turn ?? null })
          });
          return;
        }
        case "compaction/end": {
          const error = data.error;
          if (error === void 0 || error === null) return;
          const text = typeof error === "string" ? error : errorText(error);
          bus.push({
            ...sessionAttribution(sessions, id),
            severity: "error",
            source: "session",
            kind: "compaction-error",
            ...fingerprintIncident("compaction-error", text, { compactionId: data.compactionId ?? null })
          });
          return;
        }
        default:
          return;
      }
    } catch {
      bus.noteSelfFailure();
    }
  };
  ctx.on("session/event", listener);
}
function fiberFailureText(value) {
  if (value === void 0 || value === null) return "no error captured";
  const code = typeof value === "object" && value !== null && typeof value.code === "string" ? ` [${String(value.code)}]` : "";
  if (value instanceof Error) return truncate(`${value.name}: ${value.message}${code}`, 300);
  return truncate(`${String(value)}${code}`, 300);
}
function attachPluginLifecycle(ctx, bus) {
  const seen = /* @__PURE__ */ new WeakSet();
  ctx.on("internal/status", (fiber) => {
    try {
      if (fiber === null || typeof fiber !== "object") return;
      if (fiber.state !== FIBER_STATE_FAILED) return;
      if (seen.has(fiber)) return;
      seen.add(fiber);
      const name2 = typeof fiber.name === "string" && fiber.name !== "" ? fiber.name : "unknown";
      const reason = fiberFailureText(fiber._error);
      const text = `plugin fiber failed: ${name2}: ${reason}`;
      process.stderr.write(`[enpoi-diagnostics] ${text}
`);
      bus.push({
        severity: "error",
        source: "plugin",
        kind: "plugin-failed",
        ...fingerprintIncident("plugin-failed", text, { plugin: name2, fiber: name2, error: reason })
      });
    } catch {
      bus.noteSelfFailure();
    }
  });
}
function rememberSession(sessions, id, patch) {
  const previous = sessions.get(id) ?? {};
  sessions.set(id, { ...previous, ...patch });
  if (sessions.size > MAX_SESSION_CONTEXTS) {
    sessions.delete(sessions.keys().next().value);
  }
}
function sessionAttribution(sessions, id) {
  const context = sessions.get(id);
  return {
    sessionId: id,
    ...context?.provider === void 0 ? {} : { provider: context.provider },
    ...context?.model === void 0 ? {} : { model: context.model }
  };
}
function fingerprintIncident(subject, text, context = {}) {
  const fingerprinted = fingerprintMessage(subject, text);
  return {
    message: text.slice(0, 500),
    fingerprint: fingerprinted.fingerprint,
    // The stable code is derived from the fingerprint (doc 68 §L2), so equal
    // patterns always present the same code; the producer's own code travels
    // in context.errorCode when it exists.
    code: fingerprinted.code,
    context: { ...context, normalized: fingerprinted.normalized }
  };
}
function errorText(error) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (error !== null && typeof error === "object") {
    const record = error;
    if (typeof record.message === "string") return record.message;
    try {
      return JSON.stringify(error).slice(0, 500);
    } catch {
      return "[error]";
    }
  }
  return String(error);
}

// src/remote.ts
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

// src/api.ts
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";

// src/report.ts
var DEFAULT_DEGRADE_WINDOW_MS = 9e5;
var KIND_SUBSYSTEM = {
  "provider-error": { subsystem: "providers", reason: "provider errors (retryable failures) are being recorded" },
  "turn-error": { subsystem: "agent-loop", reason: "turns are ending with structured failures" },
  "tool-error": { subsystem: "tools", reason: "tool calls are returning errors" },
  "plugin-failed": { subsystem: "plugin-load", reason: "a plugin fiber failed to activate" },
  "compaction-error": { subsystem: "compaction", reason: "compaction runs are failing" },
  "client-report": { subsystem: "client", reason: "the client reported errors the host never saw" },
  "diagnostics-self": { subsystem: "diagnostics", reason: "diagnostics itself swallowed a failure" },
  "log": { subsystem: "logs", reason: "error-level log lines are flowing" }
};
function buildReport(store, capture, options = {}) {
  const now = (options.now ?? Date.now)();
  const window = options.window ?? "24h";
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 10)), 100);
  const degradeWindowMs = Math.max(0, Math.trunc(options.degradeWindowMs ?? DEFAULT_DEGRADE_WINDOW_MS));
  const since = now - degradeWindowMs;
  let patterns = [];
  let recent = [];
  let sources = [];
  let storeStats;
  let storeReadFailed = false;
  try {
    if (!store.isOpen) throw new Error("diagnostics store is not open");
    patterns = store.patterns({ window, limit, includeMuted: false }).map((row) => ({
      fingerprint: row.fingerprint,
      code: row.code,
      kind: row.kind,
      severity: row.severityMax,
      count: row.count,
      windowCount: row.windowCount,
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
      sample: row.sampleMessage,
      sources: row.sources,
      muted: row.muted
    }));
    recent = store.incidents({ limit: Math.min(limit * 3, 100) }).map((row) => ({
      id: row.id,
      at: row.at,
      severity: row.severity,
      source: row.source,
      kind: row.kind,
      code: row.code,
      fingerprint: row.fingerprint,
      message: row.message,
      count: row.count,
      sessionId: row.sessionId
    }));
    sources = store.sources(20);
    storeStats = store.stats();
  } catch {
    storeReadFailed = true;
    storeStats = {
      path: store.path,
      incidents: 0,
      patterns: 0,
      muted: 0,
      maxIncidents: 0,
      maxPatterns: 0,
      cooldownMs: 0
    };
  }
  const degraded = [];
  if (storeReadFailed) {
    degraded.push({
      subsystem: "diagnostics",
      reason: "the incident store could not be read; results are incomplete",
      count: 1,
      lastSeen: now,
      fingerprint: ""
    });
  }
  if (capture.selfFailures > 0) {
    degraded.push({
      subsystem: "diagnostics",
      reason: `diagnostics swallowed ${capture.selfFailures} internal failure(s); capture may be incomplete`,
      count: capture.selfFailures,
      lastSeen: now,
      fingerprint: ""
    });
  }
  try {
    const all = store.patterns({ window: "all", limit: 200, includeMuted: false });
    const grouped = /* @__PURE__ */ new Map();
    for (const row of all) {
      if (row.lastSeen < since) continue;
      const mapping = KIND_SUBSYSTEM[row.kind];
      if (mapping === void 0) continue;
      if (row.kind === "log") {
        if (options.includeLogs === false) continue;
        if (row.severityMax !== "error" && row.severityMax !== "fatal") continue;
      }
      if (row.kind === "turn-error") continue;
      const windowCount = row.count;
      const current = grouped.get(mapping.subsystem);
      const count = (current?.count ?? 0) + windowCount;
      grouped.set(mapping.subsystem, {
        subsystem: mapping.subsystem,
        reason: mapping.reason,
        count,
        lastSeen: Math.max(current?.lastSeen ?? 0, row.lastSeen),
        fingerprint: current?.fingerprint !== void 0 && current.fingerprint !== "" ? current.fingerprint : row.fingerprint
      });
    }
    degraded.push(...[...grouped.values()].sort((a, b) => b.lastSeen - a.lastSeen || b.count - a.count));
  } catch {
  }
  const summaryParts = [];
  summaryParts.push(`${storeStats.incidents} incident row(s) / ${storeStats.patterns} pattern(s)`);
  if (patterns.length > 0) {
    const top = patterns[0];
    summaryParts.push(`top: ${top.code} \xD7${top.count} (${top.sample.slice(0, 90)})`);
  } else {
    summaryParts.push("no patterns recorded");
  }
  if (degraded.length > 0) summaryParts.push(`degraded: ${degraded.map((entry) => entry.subsystem).join(", ")}`);
  if (capture.selfFailures > 0) summaryParts.push(`selfFailures=${capture.selfFailures}`);
  return {
    ok: !storeReadFailed,
    generatedAt: now,
    window,
    status: degraded.length > 0 ? "degraded" : "ok",
    summary: summaryParts.join(" \xB7 "),
    patterns,
    recent,
    sources,
    degraded,
    store: storeStats,
    capture
  };
}

// src/api.ts
var MAX_KIND_CHARS = 100;
var MAX_MESSAGE_CHARS2 = 4e3;
var MAX_STACK_CHARS = 1e3;
var MAX_SESSION_ID_CHARS = 200;
var MAX_URL_CHARS = 2e3;
var KIND_RE = /^[A-Za-z0-9_.:/-]+$/;
var FINGERPRINT_RE = /^[A-Za-z0-9_-]{4,64}$/;
function badRequest(method, detail) {
  return new RemoteError("gateway/bad-request", `diagnostics.${method}: ${detail}`, {});
}
function readKind(method, value) {
  if (typeof value !== "string") throw badRequest(method, "kind must be a string");
  const kind = value.trim();
  if (kind === "") throw badRequest(method, "kind must not be empty");
  if (kind.length > MAX_KIND_CHARS) throw badRequest(method, `kind must be at most ${MAX_KIND_CHARS} characters`);
  if (!KIND_RE.test(kind)) throw badRequest(method, "kind must match [A-Za-z0-9_.:/-]+");
  return kind;
}
function readMessage(method, value) {
  if (typeof value !== "string") throw badRequest(method, "message must be a string");
  const message = value.trim();
  if (message === "") throw badRequest(method, "message must not be empty");
  if (message.length > MAX_MESSAGE_CHARS2) throw badRequest(method, `message must be at most ${MAX_MESSAGE_CHARS2} characters`);
  return message;
}
function readOptional(method, field, value, max) {
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "string") throw badRequest(method, `${field} must be a string when present`);
  if (value.length > max) throw badRequest(method, `${field} must be at most ${max} characters`);
  return value;
}
function readLimit(method, value, fallback, max) {
  if (value === void 0 || value === null) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw badRequest(method, "limit must be a finite number");
  return Math.min(Math.max(1, Math.trunc(numeric)), max);
}
function readWindow(method, value) {
  if (value === void 0 || value === null) return "24h";
  if (typeof value !== "string" || !WINDOWS.includes(value)) {
    throw badRequest(method, `window must be one of ${WINDOWS.join(", ")}`);
  }
  return value;
}
function readSeverity(method, value) {
  if (value === void 0 || value === null || value === "all") return "all";
  if (typeof value !== "string" || !SEVERITIES.includes(value)) {
    throw badRequest(method, `severity must be one of ${SEVERITIES.join(", ")} or all`);
  }
  return value;
}
function validateClientReport(request) {
  const source = request ?? {};
  const kind = readKind("report", source.kind);
  const message = readMessage("report", source.message);
  const stack = readOptional("report", "stack", source.stack, MAX_STACK_CHARS);
  const sessionId = readOptional("report", "sessionId", source.sessionId, MAX_SESSION_ID_CHARS);
  const url = readOptional("report", "url", source.url, MAX_URL_CHARS);
  return {
    kind,
    message,
    ...stack === void 0 ? {} : { stack },
    ...sessionId === void 0 ? {} : { sessionId },
    ...url === void 0 ? {} : { url }
  };
}
function clientReportIncident(report) {
  const fingerprinted = fingerprintMessage(`client:${report.kind}`, report.message);
  return {
    severity: "error",
    source: "client",
    kind: "client-report",
    code: fingerprinted.code,
    fingerprint: fingerprinted.fingerprint,
    message: report.message,
    context: {
      clientKind: report.kind,
      url: report.url ?? null,
      stack: report.stack ?? null,
      normalized: fingerprinted.normalized
    },
    ...report.sessionId === void 0 ? {} : { sessionId: report.sessionId }
  };
}
function submitClientReport(bus, request) {
  const report = validateClientReport(request);
  const fingerprinted = fingerprintMessage(`client:${report.kind}`, report.message);
  try {
    bus.push(clientReportIncident(report));
  } catch {
    bus.noteSelfFailure();
  }
  return { ok: true, fingerprint: fingerprinted.fingerprint, code: fingerprinted.code };
}
function listIncidentsFrom(store, request, now, bus) {
  const source = request ?? {};
  const limit = readLimit("list", source.limit, 50, 500);
  const since = source.since === void 0 || source.since === null ? void 0 : Number(source.since);
  if (since !== void 0 && !Number.isFinite(since)) throw badRequest("list", "since must be a finite number");
  const severity = readSeverity("list", source.severity);
  try {
    bus?.flushNow();
    const items = store.incidents({
      limit,
      ...since === void 0 ? {} : { since },
      severity,
      ...source.source === void 0 || source.source === null ? {} : { source: truncate(source.source, 120) },
      ...source.kind === void 0 || source.kind === null ? {} : { kind: truncate(source.kind, 60) },
      ...source.fingerprint === void 0 || source.fingerprint === null ? {} : { fingerprint: truncate(source.fingerprint, 64) },
      includeMuted: source.includeMuted === true
    });
    return { generatedAt: now(), items };
  } catch {
    return { generatedAt: now(), items: [] };
  }
}
function listPatternsFrom(store, request, now, bus) {
  const source = request ?? {};
  const window = readWindow("patterns", source.window);
  const limit = readLimit("patterns", source.limit, 50, 500);
  const minCount = readLimit("patterns", source.minCount, 1, 1e5);
  try {
    bus?.flushNow();
    const items = store.patterns({
      window,
      limit,
      minCount,
      includeMuted: source.includeMuted === true,
      ...source.kind === void 0 || source.kind === null ? {} : { kind: truncate(source.kind, 60) }
    });
    return { window, generatedAt: now(), items };
  } catch {
    return { window, generatedAt: now(), items: [] };
  }
}
function mutePattern(store, bus, request) {
  const source = request ?? {};
  const fingerprint = readOptional("mute", "fingerprint", source.fingerprint, 64);
  if (fingerprint === void 0 || !FINGERPRINT_RE.test(fingerprint)) {
    throw badRequest("mute", "fingerprint must be 4-64 characters of [A-Za-z0-9_-]");
  }
  const muted = source.muted === void 0 ? true : source.muted === true;
  try {
    bus.flushNow();
    return store.mute(fingerprint, muted);
  } catch {
    return { ok: false, muted: false, note: "store unavailable" };
  }
}
function systemHealthFrom(store, bus, options = {}) {
  try {
    bus.flushNow();
  } catch {
    bus.noteSelfFailure();
  }
  const report = buildReport(store, bus.stats(), {
    window: "24h",
    limit: 5,
    degradeWindowMs: options.degradeWindowMs ?? DEFAULT_DEGRADE_WINDOW_MS,
    now: options.now
  });
  return {
    status: report.status,
    generatedAt: report.generatedAt,
    degraded: report.degraded,
    topPatterns: report.patterns,
    counts: {
      incidents: report.store.incidents,
      patterns: report.store.patterns,
      muted: report.store.muted
    },
    capture: report.capture,
    storePath: report.store.path
  };
}

// src/remote.ts
var DIAGNOSTICS_NAMESPACE = "diagnostics";
var _systemHealth_dec, _mute_dec, _patterns_dec, _list_dec, _report_dec, _a, _init;
var DiagnosticsService = class extends (_a = TypertRemoteService, _report_dec = [Remote], _list_dec = [Remote("list")], _patterns_dec = [Remote("patterns")], _mute_dec = [Remote], _systemHealth_dec = [Remote("systemHealth")], _a) {
  /**
   * @param ctx - owning context (service registration is automatic).
   * @param options - store, bus, and optional test seams.
   */
  constructor(ctx, options) {
    super(ctx, DIAGNOSTICS_NAMESPACE);
    __runInitializers(_init, 5, this);
    __publicField(this, "store");
    __publicField(this, "bus");
    __publicField(this, "degradeWindowMs");
    __publicField(this, "now");
    this.store = options.store;
    this.bus = options.bus;
    this.degradeWindowMs = options.degradeWindowMs ?? 0;
    this.now = options.now ?? Date.now;
  }
  report(request) {
    return submitClientReport(this.bus, request);
  }
  list(request) {
    return listIncidentsFrom(this.store, request, this.now, this.bus);
  }
  patterns(request) {
    return listPatternsFrom(this.store, request, this.now, this.bus);
  }
  mute(request) {
    return mutePattern(this.store, this.bus, request);
  }
  systemHealth() {
    return systemHealthFrom(this.store, this.bus, {
      ...this.degradeWindowMs === 0 ? {} : { degradeWindowMs: this.degradeWindowMs },
      now: this.now
    });
  }
};
_init = __decoratorStart(_a);
__decorateElement(_init, 1, "report", _report_dec, DiagnosticsService);
__decorateElement(_init, 1, "list", _list_dec, DiagnosticsService);
__decorateElement(_init, 1, "patterns", _patterns_dec, DiagnosticsService);
__decorateElement(_init, 1, "mute", _mute_dec, DiagnosticsService);
__decorateElement(_init, 1, "systemHealth", _systemHealth_dec, DiagnosticsService);
__decoratorMetadata(_init, DiagnosticsService);
/** Nothing is injected into the service fiber; the plugin passes its deps. */
__publicField(DiagnosticsService, "inject", []);

// src/tools.ts
var DIAGNOSTICS_TOOL_NAME = "diagnostics_report";
var MAX_LIMIT = 25;
function registerDiagnosticsTool(ctx, options) {
  const now = options.now ?? Date.now;
  const degradeWindowMs = options.degradeWindowMs ?? DEFAULT_DEGRADE_WINDOW_MS;
  ctx.tools.register({
    name: DIAGNOSTICS_TOOL_NAME,
    description: [
      "Report honestly about the harness incident store: top error patterns with evidence (stable code,",
      "fingerprint, counts, sample message, last seen), the recent incident tail, a per-source breakdown,",
      "and degraded subsystems (providers, tools, plugin loads, compaction, client). Deterministic \u2014 no",
      'model in the detection path. Use it to investigate "something is failing and I cannot see it".'
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        window: { type: "string", enum: [...WINDOWS], description: "Sliding window for pattern counts (default 24h)." },
        limit: { type: "number", description: `Max patterns/incidents returned (default 10, max ${MAX_LIMIT}).` },
        includeLogs: { type: "boolean", description: "Include error-level log lines in the degraded fold (default true)." }
      },
      required: []
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          window: { type: "string" },
          status: { type: "string" },
          summary: { type: "string" },
          patterns: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                fingerprint: { type: "string" },
                code: { type: "string" },
                kind: { type: "string" },
                severity: { type: "string" },
                count: { type: "number" },
                windowCount: { type: "number" },
                lastSeen: { type: "number" },
                sample: { type: "string" }
              },
              required: ["fingerprint", "code", "kind", "severity", "count", "windowCount", "lastSeen", "sample"]
            }
          },
          recent: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                at: { type: "number" },
                severity: { type: "string" },
                source: { type: "string" },
                kind: { type: "string" },
                code: { type: "string" },
                message: { type: "string" },
                count: { type: "number" },
                sessionId: { type: "string" }
              },
              required: ["at", "severity", "source", "kind", "code", "message", "count", "sessionId"]
            }
          },
          sources: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                source: { type: "string" },
                count: { type: "number" },
                lastSeen: { type: "number" }
              },
              required: ["source", "count", "lastSeen"]
            }
          },
          degraded: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                subsystem: { type: "string" },
                reason: { type: "string" },
                count: { type: "number" },
                lastSeen: { type: "number" }
              },
              required: ["subsystem", "reason", "count", "lastSeen"]
            }
          }
        },
        required: ["ok", "window", "status", "summary", "patterns", "recent", "sources", "degraded"]
      },
      render: (_args, value) => [{ type: "text", text: renderReport(value) }]
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const request = args ?? {};
      const window = typeof request.window === "string" && WINDOWS.includes(request.window) ? request.window : "24h";
      const limit = Number.isFinite(Number(request.limit)) ? Math.min(Math.max(1, Math.trunc(Number(request.limit))), MAX_LIMIT) : 10;
      try {
        options.bus.flushNow();
        const report = buildReport(options.store, options.bus.stats(), {
          window,
          limit,
          includeLogs: request.includeLogs !== false,
          degradeWindowMs,
          now: options.now ?? Date.now
        });
        return {
          ok: report.ok,
          window: report.window,
          status: report.status,
          summary: report.summary,
          patterns: report.patterns.map((pattern) => ({
            fingerprint: pattern.fingerprint,
            code: pattern.code,
            kind: pattern.kind,
            severity: pattern.severity,
            count: pattern.count,
            windowCount: pattern.windowCount,
            lastSeen: pattern.lastSeen,
            sample: pattern.sample
          })),
          recent: report.recent.map((incident) => ({
            at: incident.at,
            severity: incident.severity,
            source: incident.source,
            kind: incident.kind,
            code: incident.code,
            message: incident.message,
            count: incident.count,
            sessionId: incident.sessionId ?? ""
          })),
          sources: report.sources.map((source) => ({ source: source.source, count: source.count, lastSeen: source.lastSeen })),
          degraded: report.degraded.map((entry) => ({
            subsystem: entry.subsystem,
            reason: entry.reason,
            count: entry.count,
            lastSeen: entry.lastSeen
          }))
        };
      } catch (error) {
        return {
          ok: false,
          window,
          status: "unknown",
          summary: `diagnostics_report could not read the store: ${truncate(errorText2(error), 200)}`,
          patterns: [],
          recent: [],
          sources: [],
          degraded: []
        };
      }
    }
  });
}
function renderReport(value) {
  const report = value;
  const lines = [];
  lines.push(`diagnostics (${report.window ?? "?"}): ${report.status ?? "unknown"} \u2014 ${report.summary ?? ""}`);
  for (const pattern of report.patterns ?? []) {
    lines.push(`\u2022 ${pattern.code} \xD7${pattern.count} \u2014 ${pattern.sample.slice(0, 160)}`);
  }
  for (const entry of report.degraded ?? []) {
    lines.push(`\u26A0 ${entry.subsystem}: ${entry.reason} (${entry.count} in window)`);
  }
  return lines.join("\n");
}
function errorText2(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

// src/index.ts
var name = "enpoi-diagnostics";
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
  dbPath: live(Schema.string()),
  maxIncidents: live(Schema.number().default(5e3)),
  maxPatterns: live(Schema.number().default(2e3)),
  cooldownMs: live(Schema.number().default(3e5)),
  flushMs: live(Schema.number().default(250)),
  captureLogs: live(Schema.boolean().default(true)),
  captureSessionEvents: live(Schema.boolean().default(true)),
  capturePluginLifecycle: live(Schema.boolean().default(true)),
  minSeverity: live(Schema.union(["debug", "info", "warn", "error", "fatal"]).default("debug"))
});
function clamp(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.trunc(numeric), min), max);
}
function errorText3(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
function apply(ctx, config = {}) {
  config = plainConfig(config);
  try {
    const homeResolver = ctx.get("dshHomePath");
    const resolveHome = typeof homeResolver === "function" ? homeResolver : dshHomePath;
    const path = typeof config.dbPath === "string" && config.dbPath !== "" ? config.dbPath : resolveHome("diagnostics", "incidents.sqlite");
    const store = new IncidentStore(path, {
      maxIncidents: clamp(config.maxIncidents, 1, 1e6, 5e3),
      maxPatterns: clamp(config.maxPatterns, 1, 1e6, 2e3),
      cooldownMs: clamp(config.cooldownMs, 0, 864e5, 3e5)
    });
    const minSeverity = normalizeSeverity(config.minSeverity ?? "debug");
    let selfIncidentWritten = false;
    const bus = new IncidentBus(store, {
      flushMs: clamp(config.flushMs, 10, 6e4, 250),
      onSelfFailure: () => {
        if (selfIncidentWritten) return;
        selfIncidentWritten = true;
        try {
          const fingerprinted = fingerprintMessage("diagnostics-self", "internal failure swallowed");
          store.record({
            severity: "error",
            source: "diagnostics",
            kind: "diagnostics-self",
            code: fingerprinted.code,
            fingerprint: fingerprinted.fingerprint,
            message: "diagnostics swallowed an internal failure; capture may be incomplete"
          });
        } catch {
        }
      }
    });
    ctx.effect(() => () => {
      try {
        bus.dispose();
      } catch {
      }
      store.close();
    }, "enpoi-diagnostics.store");
    if (config.captureLogs !== false) attachLoggerSink(ctx, bus, minSeverity);
    if (config.captureSessionEvents !== false) attachSessionEvents(ctx, bus);
    if (config.capturePluginLifecycle !== false) attachPluginLifecycle(ctx, bus);
    ctx.plugin(DiagnosticsService, { store, bus });
    ctx.inject(["tools"], (toolsCtx) => {
      registerDiagnosticsTool(toolsCtx, { store, bus });
    });
    const mounted = `enpoi-diagnostics mounted (store=${path})`;
    const bootPrint = fingerprintMessage("boot", "enpoi-diagnostics mounted");
    bus.push({
      severity: "info",
      source: "diagnostics",
      kind: "boot",
      code: bootPrint.code,
      fingerprint: bootPrint.fingerprint,
      message: mounted,
      context: { path, minSeverity }
    });
    process.stderr.write(`[enpoi-diagnostics] ${mounted} maxIncidents=${String(config.maxIncidents ?? 5e3)} cooldownMs=${String(config.cooldownMs ?? 3e5)}
`);
    ctx.logger.info(`enpoi-diagnostics: ${mounted}`);
  } catch (error) {
    process.stderr.write(`[enpoi-diagnostics] disabled \u2014 ${errorText3(error)}
`);
  }
}
export {
  Config,
  DEFAULT_DEGRADE_WINDOW_MS,
  DIAGNOSTICS_NAMESPACE,
  DIAGNOSTICS_TOOL_NAME,
  DiagnosticsService,
  IncidentBus,
  IncidentStore,
  MAX_MESSAGE_CHARS,
  MAX_NORMALIZED_CHARS,
  SEVERITIES,
  WINDOWS,
  apply,
  buildReport,
  fingerprintMessage,
  inject,
  listIncidentsFrom,
  listPatternsFrom,
  mutePattern,
  name,
  normalizeMessage,
  normalizeSeverity,
  registerDiagnosticsTool,
  severityRank,
  submitClientReport,
  systemHealthFrom
};
