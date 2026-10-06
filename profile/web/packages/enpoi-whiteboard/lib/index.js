// src/index.ts
import Schema from "@deepseek-ai/schemastery";
import { readOrchestrationDocument } from "dsh-enpoi-contracts";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

// src/board.ts
var WHITEBOARD_CONTEXT_ORDER = 140;
var WHITEBOARD_CONTEXT_NAME = "whiteboard";
var WHITEBOARD_HEADER = "### Pinned context";
var DEFAULT_BUDGET_TOKENS = 1500;
var DEFAULT_MAX_SESSION_BOARDS = 200;
var CHARS_PER_TOKEN = 4;
var EMPTY_WHITEBOARD = Object.freeze({
  version: 0,
  scope: "global",
  entries: [],
  updatedAt: 0
});
var EMPTY_BOARD = Object.freeze({
  version: 0,
  entries: [],
  updatedAt: 0
});
var KINDS = ["path", "rule", "fact", "task"];
var SCOPES = ["session", "project", "global"];
function isWhiteboardScope(value2) {
  return typeof value2 === "string" && SCOPES.includes(value2);
}
function isWhiteboardEntryKind(value2) {
  return typeof value2 === "string" && KINDS.includes(value2);
}
function isRecord(value2) {
  return typeof value2 === "object" && value2 !== null && !Array.isArray(value2);
}
function finiteVersion(value2) {
  return typeof value2 === "number" && Number.isFinite(value2) && value2 >= 0 ? Math.floor(value2) : 0;
}
function normalizeEntry(raw) {
  if (!isRecord(raw)) return void 0;
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  const kind = isWhiteboardEntryKind(raw.kind) ? raw.kind : void 0;
  if (text.length === 0 || kind === void 0) return void 0;
  const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : `wb-${Math.random().toString(36).slice(2, 10)}`;
  const version = typeof raw.version === "number" && Number.isFinite(raw.version) && raw.version >= 1 ? Math.floor(raw.version) : 1;
  const entry = {
    id,
    kind,
    text,
    pinned: raw.pinned === true,
    pinnedAt: typeof raw.pinnedAt === "number" && Number.isFinite(raw.pinnedAt) ? raw.pinnedAt : 0,
    version
  };
  if (typeof raw.lastValidatedAt === "number" && Number.isFinite(raw.lastValidatedAt)) entry.lastValidatedAt = raw.lastValidatedAt;
  if (raw.stale === true) entry.stale = true;
  return entry;
}
function normalizeBoard(raw) {
  if (!isRecord(raw)) return { ...EMPTY_BOARD, entries: [] };
  const entries = Array.isArray(raw.entries) ? raw.entries.map(normalizeEntry).filter((entry) => entry !== void 0) : [];
  return {
    version: finiteVersion(raw.version),
    entries,
    updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0
  };
}
function normalizeDoc(raw) {
  if (!isRecord(raw)) return { ...EMPTY_WHITEBOARD, entries: [] };
  const board = normalizeBoard(raw);
  const doc = {
    version: board.version,
    scope: isWhiteboardScope(raw.scope) ? raw.scope : "global",
    entries: board.entries,
    updatedAt: board.updatedAt
  };
  if (typeof raw.sessionId === "string" && raw.sessionId.length > 0) doc.sessionId = raw.sessionId;
  if (typeof raw.projectId === "string" && raw.projectId.length > 0) doc.projectId = raw.projectId;
  const writtenBySessionId = isRecord(raw.meta) && typeof raw.meta.writtenBySessionId === "string" ? raw.meta.writtenBySessionId.trim() : "";
  if (writtenBySessionId.length > 0) doc.meta = { writtenBySessionId };
  return doc;
}
function emptyStore() {
  return { version: 0, docs: { projects: {}, sessions: {} } };
}
function legacyStore(legacy) {
  const store = emptyStore();
  store.version = legacy.version;
  const board = { version: legacy.version, entries: legacy.entries, updatedAt: legacy.updatedAt };
  if (legacy.scope === "project" && legacy.projectId !== void 0) store.docs.projects[legacy.projectId] = board;
  else if (legacy.scope === "session" && legacy.sessionId !== void 0) store.docs.sessions[legacy.sessionId] = board;
  else if (legacy.meta?.writtenBySessionId !== void 0) store.docs.sessions[legacy.meta.writtenBySessionId] = board;
  else store.docs.global = board;
  return store;
}
function normalizeStore(raw) {
  if (!isRecord(raw)) return emptyStore();
  if (isRecord(raw.docs)) {
    const store = emptyStore();
    store.version = finiteVersion(raw.version);
    if (isRecord(raw.docs.global)) store.docs.global = normalizeBoard(raw.docs.global);
    for (const bucket of ["projects", "sessions"]) {
      const value2 = raw.docs[bucket];
      if (!isRecord(value2)) continue;
      for (const [key, board] of Object.entries(value2)) {
        if (key.length === 0 || !isRecord(board)) continue;
        store.docs[bucket][key] = normalizeBoard(board);
      }
    }
    return store;
  }
  return legacyStore(normalizeDoc(raw));
}
function migrateLegacyStore(raw, attributeToSessionId) {
  if (!isRecord(raw)) return { store: normalizeStore(raw), migrated: false, entries: 0 };
  if (isRecord(raw.docs)) {
    return { store: normalizeStore(raw), migrated: false, entries: 0 };
  }
  const doc = normalizeDoc(raw);
  let attributedTo = doc.scope === "global" && doc.meta?.writtenBySessionId !== void 0 ? doc.meta.writtenBySessionId : void 0;
  if (attributedTo === void 0 && doc.scope === "global" && typeof attributeToSessionId === "string" && attributeToSessionId.length > 0) {
    doc.meta = { ...doc.meta, writtenBySessionId: attributeToSessionId };
    attributedTo = attributeToSessionId;
  }
  return {
    store: legacyStore(doc),
    migrated: true,
    entries: doc.entries.length,
    ...attributedTo === void 0 ? {} : { attributedTo }
  };
}
function readBoard(store, target) {
  if (target.scope === "global") return store.docs.global;
  if (target.scope === "project") return store.docs.projects[target.projectId];
  return store.docs.sessions[target.sessionId];
}
function writeBoard(store, target, board) {
  const docs = {
    ...store.docs,
    projects: { ...store.docs.projects },
    sessions: { ...store.docs.sessions }
  };
  if (target.scope === "global") docs.global = board;
  else if (target.scope === "project") docs.projects[target.projectId] = board;
  else docs.sessions[target.sessionId] = board;
  return { ...store, docs };
}
function resolveBoard(store, facts) {
  const layers = [
    { scope: "global", board: store.docs.global }
  ];
  if (facts.projectId !== void 0) layers.push({ scope: "project", board: store.docs.projects[facts.projectId] });
  if (facts.parentSessionId !== void 0 && facts.parentSessionId !== facts.sessionId) {
    layers.push({ scope: "session", board: store.docs.sessions[facts.parentSessionId] });
  }
  if (facts.sessionId !== void 0) layers.push({ scope: "session", board: store.docs.sessions[facts.sessionId] });
  const merged = /* @__PURE__ */ new Map();
  let scope = "global";
  let updatedAt = 0;
  for (const layer of layers) {
    const board = layer.board;
    if (board === void 0 || board.entries.length === 0) continue;
    scope = layer.scope;
    if (board.updatedAt > updatedAt) updatedAt = board.updatedAt;
    for (const entry of board.entries) merged.set(entry.id, { ...entry, scope: layer.scope });
  }
  return { version: store.version, scope, entries: [...merged.values()], updatedAt };
}
function findEntryTarget(store, facts, id) {
  const has = (board) => board !== void 0 && board.entries.some((entry) => entry.id === id);
  if (facts.sessionId !== void 0 && has(store.docs.sessions[facts.sessionId])) {
    return { scope: "session", sessionId: facts.sessionId };
  }
  if (facts.parentSessionId !== void 0 && facts.parentSessionId !== facts.sessionId && has(store.docs.sessions[facts.parentSessionId])) {
    return { scope: "session", sessionId: facts.parentSessionId };
  }
  if (facts.projectId !== void 0 && has(store.docs.projects[facts.projectId])) {
    return { scope: "project", projectId: facts.projectId };
  }
  if (has(store.docs.global)) return { scope: "global" };
  return void 0;
}
function renderWhiteboard(doc) {
  if (doc.entries.length === 0) return "";
  const lines = doc.entries.slice().sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return 0;
  }).map((entry) => {
    const marker = entry.pinned ? "\u{1F4CC} " : "";
    const stale = entry.stale === true ? " (stale)" : "";
    return `- ${marker}[${entry.kind}] ${entry.text}${stale}`;
  });
  return `${WHITEBOARD_HEADER} (v${doc.version})
${lines.join("\n")}`;
}
function boardChars(rendered) {
  return Array.from(rendered).length;
}
function estimateTokens(rendered) {
  return Math.ceil(boardChars(rendered) / CHARS_PER_TOKEN);
}
function budgetChars(budgetTokens) {
  return Math.max(0, Math.floor(budgetTokens)) * CHARS_PER_TOKEN;
}
function checkBudget(doc, budgetTokens) {
  const chars = boardChars(renderWhiteboard(doc));
  const tokens = Math.ceil(chars / CHARS_PER_TOKEN);
  const limit = budgetChars(budgetTokens);
  return { ok: chars <= limit, tokens, budget: budgetTokens, chars, limit };
}
function lintPaths(doc, resolvePath, exists, now) {
  const stale = [];
  const entries = doc.entries.map((entry) => {
    if (entry.kind !== "path") return entry;
    let resolved;
    try {
      resolved = resolvePath(entry);
    } catch {
      resolved = entry.text;
    }
    const present = resolved.length > 0 && exists(resolved);
    const next = { ...entry, lastValidatedAt: now };
    if (present) delete next.stale;
    else {
      next.stale = true;
      stale.push(entry.id);
    }
    return next;
  });
  return { doc: { ...doc, entries }, stale };
}
function applyWrites(board, requests, mode, now) {
  const entries = board.entries.map((entry) => ({ ...entry }));
  for (const request of requests) {
    if (!isWhiteboardEntryKind(request.kind)) return { ok: false, message: `unknown entry kind "${String(request.kind)}"` };
    const text = typeof request.text === "string" ? request.text.trim() : "";
    if (text.length === 0) return { ok: false, message: "entry text must be a non-empty string" };
    if (mode === "replace") {
      const id2 = request.replaceId ?? request.id;
      if (typeof id2 !== "string" || id2.length === 0) return { ok: false, message: 'mode "replace" requires each entry to carry the id it replaces' };
      const index = entries.findIndex((entry) => entry.id === id2);
      if (index === -1) return { ok: false, message: `no entry with id "${id2}" to replace` };
      const previous = entries[index];
      const next = {
        id: id2,
        kind: request.kind,
        text,
        pinned: request.pinned ?? previous.pinned,
        pinnedAt: request.pinned === true && previous.pinned !== true ? now : previous.pinnedAt,
        version: previous.version + 1
      };
      entries[index] = next;
      continue;
    }
    const id = typeof request.id === "string" && request.id.length > 0 ? request.id : `wb-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    if (entries.some((entry) => entry.id === id)) {
      return { ok: false, message: `entry id "${id}" already exists \u2014 use mode "replace" to overwrite it` };
    }
    entries.push({
      id,
      kind: request.kind,
      text,
      pinned: request.pinned === true,
      pinnedAt: request.pinned === true ? now : 0,
      version: 1
    });
  }
  return { ok: true, board: { ...board, entries } };
}
function applyStoreWrites(store, target, requests, mode, now) {
  const current = readBoard(store, target) ?? EMPTY_BOARD;
  const applied = applyWrites(current, requests, mode, now);
  if (!applied.ok) return applied;
  const board = { ...applied.board, version: current.version + 1, updatedAt: now };
  return { ok: true, store: writeBoard(store, target, board) };
}
function setPinned(board, id, pinned, now) {
  const index = board.entries.findIndex((entry) => entry.id === id);
  if (index === -1) return { ok: false, message: `no entry with id "${id}"` };
  const entries = board.entries.map((entry, at) => at === index ? { ...entry, pinned, pinnedAt: pinned ? now : entry.pinnedAt } : { ...entry });
  return { ok: true, board: { ...board, entries } };
}
function setStorePinned(store, target, id, pinned, now) {
  const current = readBoard(store, target);
  if (current === void 0) return { ok: false, message: `no entry with id "${id}"` };
  const pinnedResult = setPinned(current, id, pinned, now);
  if (!pinnedResult.ok) return pinnedResult;
  const board = { ...pinnedResult.board, version: current.version + 1, updatedAt: now };
  return { ok: true, store: writeBoard(store, target, board) };
}
function removeEntry(board, id, now) {
  const index = board.entries.findIndex((entry) => entry.id === id);
  if (index === -1) return { ok: false, message: `no entry with id "${id}"` };
  const removed = { ...board.entries[index] };
  const entries = board.entries.filter((_, at) => at !== index).map((entry) => ({ ...entry }));
  return { ok: true, board: { ...board, entries, updatedAt: now }, removed };
}
function removeStoreEntry(store, target, id, now) {
  const current = readBoard(store, target);
  if (current === void 0) return { ok: false, message: `no entry with id "${id}"` };
  const removal = removeEntry(current, id, now);
  if (!removal.ok) return removal;
  const board = { ...removal.board, version: current.version + 1, updatedAt: now };
  return { ok: true, store: writeBoard(store, target, board), removed: removal.removed };
}
function sweepSessionBoards(store, limit) {
  const ids = Object.keys(store.docs.sessions);
  if (!Number.isFinite(limit) || ids.length <= Math.max(0, Math.floor(limit))) return { store, dropped: [] };
  const ordered = [...ids].sort((left, right) => {
    const leftAt = store.docs.sessions[left]?.updatedAt ?? 0;
    const rightAt = store.docs.sessions[right]?.updatedAt ?? 0;
    if (leftAt !== rightAt) return leftAt - rightAt;
    return left < right ? -1 : 1;
  });
  const dropped = ordered.slice(0, ids.length - Math.max(0, Math.floor(limit)));
  const sessions = { ...store.docs.sessions };
  for (const id of dropped) delete sessions[id];
  return { store: { ...store, docs: { ...store.docs, sessions } }, dropped };
}
function versionLine(doc) {
  return `${WHITEBOARD_HEADER} v${doc.version} (${doc.scope}${doc.updatedAt > 0 ? ` \xB7 updated ${new Date(doc.updatedAt).toISOString()}` : ""})`;
}

// src/index.ts
var name = "enpoi-whiteboard";
var inject = ["tools"];
function live(schema) {
  return schema.volatile?.() ?? schema;
}
function value(field) {
  return typeof field?.get === "function" ? field.get() : field;
}
var Config = Schema.object({
  budgetTokens: live(Schema.number().default(DEFAULT_BUDGET_TOKENS)),
  maxSessionBoards: live(Schema.number().default(DEFAULT_MAX_SESSION_BOARDS))
});
var ORCH_NS = "enpoi-orchestration";
function settingsOf(ctx) {
  try {
    return ctx.get("settings");
  } catch {
    return void 0;
  }
}
var legacyReadLogged = false;
function readWhiteboardStore(ctx) {
  try {
    const doc = readOrchestrationDocument(settingsOf(ctx));
    const migration = migrateLegacyStore(doc?.whiteboard);
    if (migration.migrated && !legacyReadLogged) {
      legacyReadLogged = true;
      const destination = migration.attributedTo === void 0 ? "global" : `session ${migration.attributedTo}`;
      process.stderr.write(`[enpoi-whiteboard] legacy board read (${migration.entries} entries) \u2014 migrated in memory into ${destination}
`);
    }
    return migration.store;
  } catch {
    return normalizeStore(void 0);
  }
}
function readWhiteboard(ctx, facts = {}) {
  return resolveBoard(readWhiteboardStore(ctx), facts);
}
function toolCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
}
function agentFacts(agent) {
  const facts = {};
  const session = agent?.session;
  const id = session?.id;
  if (typeof id === "string" && id.length > 0) facts.sessionId = id;
  const parent = session?.header?.parentSession;
  if (typeof parent === "string" && parent.length > 0) facts.parentSessionId = parent;
  const cwd = session?.header?.cwd;
  if (typeof cwd === "string" && cwd.length > 0) facts.projectId = cwd;
  return facts;
}
function sessionFacts(exec) {
  return agentFacts(exec?.agent);
}
var CHILD_AUTHORING_REFUSAL = "the whiteboard is authored by the main session; children read it";
function isChildSession(exec) {
  return sessionFacts(exec).parentSessionId !== void 0;
}
function resolveEntryPath(entry, cwd) {
  return isAbsolute(entry.text) ? entry.text : resolve(cwd, entry.text);
}
function linted(doc, exec) {
  const cwd = toolCwd(exec);
  return lintPaths(doc, (entry) => resolveEntryPath(entry, cwd), existsSync, Date.now()).doc;
}
function refusal(message, extra = {}) {
  return { ok: false, reason: "refused", message, ...extra };
}
async function commitStore(ctx, config, checkFacts, build) {
  const settings = settingsOf(ctx);
  if (settings?.mutate === void 0) return { ok: false, message: "settings service unavailable \u2014 board not written" };
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = Date.now();
    const current = readWhiteboardStore(ctx);
    const built = build(current, now);
    if (!built.ok) return { ok: false, message: built.message };
    const next = { ...built.store, version: current.version + 1 };
    const check = checkBudget(resolveBoard(next, checkFacts), config.budgetTokens);
    if (!check.ok) {
      return {
        ok: false,
        message: `Over budget: the resolved board renders ${check.tokens} tokens (budget ${check.budget}). Nothing was written.`,
        tokens: check.tokens,
        budget: check.budget
      };
    }
    const revision = settings.describe?.().find((entry) => entry.ns === ORCH_NS)?.revision;
    try {
      await settings.mutate(ORCH_NS, [{ op: "set", path: ["whiteboard"], value: next }], revision);
      return { ok: true, store: next };
    } catch (error) {
      lastError = error;
      if (error?.code === "SETTINGS_CONFLICT" && attempt < 2) continue;
      return { ok: false, message: `board write failed: ${String(error)}` };
    }
  }
  return { ok: false, message: `board write failed after retries: ${String(lastError)}` };
}
var BOARD_RESULT_PROPERTIES = {
  ok: { type: "boolean" },
  reason: { type: "string" },
  message: { type: "string" },
  version: { type: "number" },
  scope: { type: "string" },
  tokens: { type: "number" },
  budget: { type: "number" },
  entries: { type: "array", items: { type: "object", additionalProperties: true } },
  stale: { type: "array", items: { type: "string" } },
  rendered: { type: "string" },
  versionLine: { type: "string" },
  note: { type: "string" }
};
function boardView(resolved, budgetTokens) {
  const rendered = renderWhiteboard(resolved);
  const entries = resolved.entries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    text: entry.text,
    pinned: entry.pinned,
    version: entry.version,
    scope: entry.scope,
    ...entry.stale === true ? { stale: true } : {}
  }));
  const stale = resolved.entries.filter((entry) => entry.stale === true).map((entry) => entry.id);
  return {
    ok: true,
    version: resolved.version,
    scope: resolved.scope,
    tokens: estimateTokens(rendered),
    budget: budgetTokens,
    entries,
    stale,
    rendered,
    versionLine: versionLine(resolved)
  };
}
function writeTargetFor(exec, args) {
  const own = sessionFacts(exec);
  const scope = isWhiteboardScope(args.scope) ? args.scope : "session";
  if (scope === "global") return { target: { scope: "global" }, checkFacts: own };
  if (scope === "project") {
    const explicit2 = typeof args.projectId === "string" && args.projectId.length > 0 ? args.projectId : void 0;
    const projectId = explicit2 ?? toolCwd(exec);
    return { target: { scope: "project", projectId }, checkFacts: { projectId } };
  }
  const explicit = typeof args.sessionId === "string" && args.sessionId.length > 0 ? args.sessionId : void 0;
  const sessionId = explicit ?? own.sessionId;
  if (sessionId === void 0) return { error: 'scope "session" requires a session id and this execution has none' };
  return {
    target: { scope: "session", sessionId },
    checkFacts: sessionId === own.sessionId ? own : { sessionId }
  };
}
function targetKey(target) {
  if (target.scope === "global") return "global";
  if (target.scope === "project") return `project:${target.projectId}`;
  return `session:${target.sessionId}`;
}
function planWriteTargets(store, fallback, facts, requests, mode, explicitScope) {
  if (mode !== "replace" || explicitScope) return { ok: true, groups: [{ target: fallback, requests: [...requests] }] };
  const groups = [];
  const byKey = /* @__PURE__ */ new Map();
  for (const request of requests) {
    const id = request.replaceId ?? request.id;
    if (typeof id !== "string" || id.length === 0) {
      return { ok: false, message: 'mode "replace" requires each entry to carry the id it replaces' };
    }
    const target = findEntryTarget(store, facts, id) ?? fallback;
    const key = targetKey(target);
    const at = byKey.get(key);
    if (at === void 0) {
      byKey.set(key, groups.length);
      groups.push({ target, requests: [request] });
    } else groups[at].requests.push(request);
  }
  return { ok: true, groups };
}
function registerTools(ctx, config) {
  const tools = ctx.tools;
  if (tools?.register === void 0) {
    process.stderr.write("[enpoi-whiteboard] no tools service \u2014 board tools not mounted\n");
    return;
  }
  tools.register({
    name: "whiteboard_read",
    description: [
      "Read the pinned context board resolved for this session: global entries, then this project's, then this session's (a direct child also inherits its parent session's), later scopes overriding earlier ones by entry id.",
      "Every entry reports the scope that authored it. Returns the exact injected block, its token cost, and stale path flags."
    ].join(" "),
    parameters: { type: "object", properties: {}, required: [] },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ...BOARD_RESULT_PROPERTIES,
          entries: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                kind: { type: "string" },
                text: { type: "string" },
                pinned: { type: "boolean" },
                version: { type: "number" },
                scope: { type: "string" },
                stale: { type: "boolean" }
              },
              required: ["id", "kind", "text", "pinned", "version", "scope"]
            }
          },
          stale: { type: "array", items: { type: "string" } },
          rendered: { type: "string" },
          versionLine: { type: "string" }
        },
        required: ["ok", "version", "scope", "tokens", "budget", "entries", "stale", "rendered", "versionLine"]
      },
      render: (_args, value2) => [{ type: "text", text: renderWhiteboardResult(value2) }]
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return boardView(linted(readWhiteboard(ctx, sessionFacts(exec)), exec), config.budgetTokens);
    }
  });
  tools.register({
    name: "whiteboard_write",
    description: [
      "Author the pinned context board for one scope. scope defaults to session (your own session); project stores under your session cwd (or projectId) and applies to that project; global applies to every session.",
      "Append entries, or replace entries by id (every replace bumps the entry version). A replace under the default session scope replaces the entry in the scope that authored it, so a project/global entry is replaced there.",
      "Kinds: path (project-relative path \u2014 validated on write, flagged stale when missing, never deleted), rule, fact, task.",
      "The resolved block has a HARD token budget; an over-budget write is refused and nothing changes.",
      "Keep only core context the orchestrator must not have to repeat: current docs, invariants, task state."
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["append", "replace"], description: "append (default) adds entries; replace overwrites the entry named by replaceId" },
        scope: { type: "string", enum: ["session", "project", "global"], description: "Where entries land (default: session \u2014 the calling session)" },
        sessionId: { type: "string", description: "Session id when scope=session (default: the calling session)" },
        projectId: { type: "string", description: "Project cwd when scope=project (default: the calling session cwd)" },
        entries: {
          type: "array",
          description: "Entries to write",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", description: "Stable id; required for append-with-known-id, and the old id for replace" },
              kind: { type: "string", enum: ["path", "rule", "fact", "task"] },
              text: { type: "string", description: "One compact line" },
              pinned: { type: "boolean", description: "Pinned entries sort first and are never compacted" }
            },
            required: ["kind", "text"]
          }
        }
      },
      required: ["entries"]
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { ...BOARD_RESULT_PROPERTIES },
        required: ["ok"]
      },
      render: (_args, value2) => [{ type: "text", text: renderWriteResult(value2) }]
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (isChildSession(exec)) return refusal(CHILD_AUTHORING_REFUSAL);
      const mode = args.mode === "replace" ? "replace" : "append";
      const rawEntries = args.entries;
      if (!Array.isArray(rawEntries) || rawEntries.length === 0) return refusal("entries must be a non-empty array");
      const requests = [];
      for (const raw of rawEntries) {
        const row = raw;
        const kind = row.kind;
        if (kind !== "path" && kind !== "rule" && kind !== "fact" && kind !== "task") {
          return refusal(`entries[].kind must be one of path|rule|fact|task (got ${JSON.stringify(kind)})`);
        }
        requests.push({
          kind,
          text: typeof row.text === "string" ? row.text : "",
          ...typeof row.id === "string" ? { id: row.id } : {},
          ...mode === "replace" && typeof row.id === "string" ? { replaceId: row.id } : {},
          ...row.pinned === true ? { pinned: true } : {}
        });
      }
      const target = writeTargetFor(exec, args);
      if ("error" in target) return refusal(target.error);
      const explicitScope = isWhiteboardScope(args.scope);
      const facts = sessionFacts(exec);
      const committed = await commitStore(ctx, config, target.checkFacts, (store, now) => {
        const plan = planWriteTargets(store, target.target, facts, requests, mode, explicitScope);
        if (!plan.ok) return plan;
        let next = store;
        for (const group of plan.groups) {
          const applied = applyStoreWrites(next, group.target, group.requests, mode, now);
          if (!applied.ok) return applied;
          const board = readBoard(applied.store, group.target);
          next = board === void 0 ? applied.store : writeBoard(applied.store, group.target, linted(board, exec));
        }
        return { ok: true, store: next };
      });
      if (!committed.ok) return refusal(committed.message, committed.tokens === void 0 ? {} : { tokens: committed.tokens, budget: committed.budget });
      const resolved = resolveBoard(committed.store, facts);
      const stale = resolved.entries.filter((entry) => entry.stale === true).map((entry) => entry.id);
      return {
        ...boardView(linted(resolved, exec), config.budgetTokens),
        note: stale.length > 0 ? `${stale.length} path entry(ies) flagged stale (missing on disk) \u2014 prune or repoint them` : "written"
      };
    }
  });
  tools.register({
    name: "whiteboard_pin",
    description: "Pin a whiteboard entry in the scope that authored it (pinned entries sort first and are never compacted). Pinning never rewrites the entry text.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Entry id from whiteboard_read" } },
      required: ["id"]
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { ...BOARD_RESULT_PROPERTIES },
        required: ["ok"]
      },
      render: (_args, value2) => [{ type: "text", text: renderWriteResult(value2) }]
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (isChildSession(exec)) return refusal(CHILD_AUTHORING_REFUSAL);
      const id = typeof args.id === "string" ? args.id : "";
      if (id.length === 0) return refusal("id is required");
      const facts = sessionFacts(exec);
      const committed = await commitStore(ctx, config, facts, (store, now) => {
        const target = findEntryTarget(store, facts, id);
        if (target === void 0) return { ok: false, message: `no entry with id "${id}" in this session's resolved board` };
        return setStorePinned(store, target, id, true, now);
      });
      if (!committed.ok) return refusal(committed.message, committed.tokens === void 0 ? {} : { tokens: committed.tokens, budget: committed.budget });
      return { ...boardView(linted(resolveBoard(committed.store, facts), exec), config.budgetTokens), note: `pinned ${id}` };
    }
  });
  tools.register({
    name: "whiteboard_unpin",
    description: "Unpin a whiteboard entry in the scope that authored it. Unpinning never deletes the entry; the operator prunes explicitly.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Entry id from whiteboard_read" } },
      required: ["id"]
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { ...BOARD_RESULT_PROPERTIES },
        required: ["ok"]
      },
      render: (_args, value2) => [{ type: "text", text: renderWriteResult(value2) }]
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (isChildSession(exec)) return refusal(CHILD_AUTHORING_REFUSAL);
      const id = typeof args.id === "string" ? args.id : "";
      if (id.length === 0) return refusal("id is required");
      const facts = sessionFacts(exec);
      const committed = await commitStore(ctx, config, facts, (store, now) => {
        const target = findEntryTarget(store, facts, id);
        if (target === void 0) return { ok: false, message: `no entry with id "${id}" in this session's resolved board` };
        return setStorePinned(store, target, id, false, now);
      });
      if (!committed.ok) return refusal(committed.message, committed.tokens === void 0 ? {} : { tokens: committed.tokens, budget: committed.budget });
      return { ...boardView(linted(resolveBoard(committed.store, facts), exec), config.budgetTokens), note: `unpinned ${id}` };
    }
  });
  tools.register({
    name: "whiteboard_forget",
    description: "Delete one whiteboard entry in the scope that authored it (own session, then parent session, then project, then global). The removed entry \u2014 including its text \u2014 is returned, so nothing is ever dropped silently.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Entry id from whiteboard_read" } },
      required: ["id"]
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ...BOARD_RESULT_PROPERTIES,
          removed: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              kind: { type: "string" },
              text: { type: "string" },
              pinned: { type: "boolean" },
              version: { type: "number" },
              scope: { type: "string" }
            },
            required: ["id", "kind", "text", "pinned", "version", "scope"]
          }
        },
        required: ["ok"]
      },
      render: (_args, value2) => [{ type: "text", text: renderForgetResult(value2) }]
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (isChildSession(exec)) return refusal(CHILD_AUTHORING_REFUSAL);
      const id = typeof args.id === "string" ? args.id : "";
      if (id.length === 0) return refusal("id is required");
      const facts = sessionFacts(exec);
      let removed;
      const committed = await commitStore(ctx, config, facts, (store, now) => {
        const target = findEntryTarget(store, facts, id);
        if (target === void 0) return { ok: false, message: `no entry with id "${id}" in this session's resolved board` };
        const result = removeStoreEntry(store, target, id, now);
        if (!result.ok) return result;
        removed = {
          id: result.removed.id,
          kind: result.removed.kind,
          text: result.removed.text,
          pinned: result.removed.pinned,
          version: result.removed.version,
          scope: target.scope
        };
        return { ok: true, store: result.store };
      });
      if (!committed.ok) return refusal(committed.message, committed.tokens === void 0 ? {} : { tokens: committed.tokens, budget: committed.budget });
      const view = boardView(linted(resolveBoard(committed.store, facts), exec), config.budgetTokens);
      return removed === void 0 ? { ...view, note: `forgot ${id}` } : { ...view, removed, note: `forgot ${id}: ${String(removed.text)}` };
    }
  });
}
function renderWhiteboardResult(value2) {
  const entries = Array.isArray(value2.entries) ? value2.entries : [];
  if (entries.length === 0) return `Whiteboard v${String(value2.version)} resolves to no entries for this session (0/${String(value2.budget)} tokens).`;
  const lines = entries.map((entry) => `\u2022 ${entry.pinned === true ? "\u{1F4CC} " : ""}[${String(entry.kind)}] ${String(entry.text)}${entry.stale === true ? " (stale)" : ""} \u2014 ${String(entry.id)} v${String(entry.version)} \xB7 ${String(entry.scope)}`);
  return [...lines, `\u2014 v${String(value2.version)} \xB7 ${String(value2.scope)} \xB7 ${String(value2.tokens)}/${String(value2.budget)} tokens`].join("\n");
}
function renderWriteResult(value2) {
  if (value2.ok !== true) return String(value2.message ?? "Whiteboard write refused.");
  const stale = Array.isArray(value2.stale) ? value2.stale : [];
  const head = `Whiteboard v${String(value2.version)} (${String(value2.scope)}) \u2014 ${stale.length} stale path flag(s).`;
  const rendered = typeof value2.rendered === "string" && value2.rendered.length > 0 ? value2.rendered : "(empty)";
  return `${head}
${rendered}`;
}
function renderForgetResult(value2) {
  if (value2.ok !== true) return String(value2.message ?? "Whiteboard forget refused.");
  const raw = value2.removed;
  const removed = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : void 0;
  const head = removed === void 0 ? "Whiteboard entry forgotten." : `Forgot [${String(removed.kind)}] ${String(removed.text)} \u2014 ${String(removed.id)} (${String(removed.scope)}).`;
  const rendered = typeof value2.rendered === "string" && value2.rendered.length > 0 ? value2.rendered : "(empty)";
  return `${head}
${rendered}`;
}
var SESSION_SWEEP_DELAY_MS = 2e3;
async function sweepSessionBoardsNow(ctx, config) {
  const pending = sweepSessionBoards(readWhiteboardStore(ctx), config.maxSessionBoards);
  if (pending.dropped.length === 0) return;
  let dropped = [];
  const committed = await commitStore(ctx, config, {}, (current) => {
    const next = sweepSessionBoards(current, config.maxSessionBoards);
    dropped = next.dropped;
    return { ok: true, store: next.store };
  });
  if (!committed.ok) {
    process.stderr.write(`[enpoi-whiteboard] session-board GC skipped: ${committed.message}
`);
    return;
  }
  if (dropped.length > 0) {
    process.stderr.write(`[enpoi-whiteboard] session-board GC dropped ${dropped.length} board(s) over the ${config.maxSessionBoards} limit: ${dropped.join(", ")}
`);
  }
}
function scheduleSessionSweep(ctx, config) {
  const timer = setTimeout(() => {
    void sweepSessionBoardsNow(ctx, config).catch((error) => {
      process.stderr.write(`[enpoi-whiteboard] session-board GC failed: ${String(error)}
`);
    });
  }, SESSION_SWEEP_DELAY_MS);
  timer.unref();
  ctx.effect(() => () => {
    clearTimeout(timer);
  }, "enpoi-whiteboard: session-board GC");
}
function installInjection(ctx) {
  const systemPrompt = ctx.get("systemPrompt");
  if (systemPrompt?.context === void 0) {
    process.stderr.write("[enpoi-whiteboard] no systemPrompt service \u2014 runtime-context injection skipped\n");
    return;
  }
  const dispose = systemPrompt.context({
    name: WHITEBOARD_CONTEXT_NAME,
    order: WHITEBOARD_CONTEXT_ORDER,
    text: (assembly) => {
      try {
        const resolved = resolveBoard(readWhiteboardStore(ctx), agentFacts(assembly?.agent));
        return renderWhiteboard(resolved);
      } catch {
        return "";
      }
    }
  });
  ctx.effect(() => dispose, "enpoi-whiteboard: runtime-context injection");
}
function apply(ctx, config = {}) {
  const budgetTokens = value(config.budgetTokens);
  const maxSessionBoards = value(config.maxSessionBoards);
  const resolved = {
    budgetTokens: typeof budgetTokens === "number" && Number.isFinite(budgetTokens) && budgetTokens > 0 ? Math.floor(budgetTokens) : DEFAULT_BUDGET_TOKENS,
    maxSessionBoards: typeof maxSessionBoards === "number" && Number.isFinite(maxSessionBoards) && maxSessionBoards >= 1 ? Math.floor(maxSessionBoards) : DEFAULT_MAX_SESSION_BOARDS
  };
  registerTools(ctx, resolved);
  installInjection(ctx);
  scheduleSessionSweep(ctx, resolved);
  process.stderr.write(`[enpoi-whiteboard] mounted (budget ${resolved.budgetTokens} tokens, ${resolved.maxSessionBoards} session boards max; per-scope board resolved lazily per assembly; runtime-context seam)
`);
}
export {
  Config,
  apply,
  inject,
  name,
  readWhiteboard,
  readWhiteboardStore
};
