// src/index.ts
import Schema from "@deepseek-ai/schemastery";
import { readOrchestrationDocument } from "dsh-enpoi-contracts";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
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
function hostPathSyntax() {
  return process.platform === "win32" ? "windows" : "posix";
}
var WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+)/;
var POSIX_ABSOLUTE = /^\//;
var HOME_RELATIVE = /^~($|[\\/])/;
var URL_TEXT = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
var GLOB_TEXT = /[*?[\]{}]/;
function hasPathSignal(value2) {
  if (value2.includes("/") || value2.includes("\\")) return true;
  const base = value2.split(/[\\/]/).pop() ?? value2;
  const dot = base.lastIndexOf(".");
  return dot >= 0 && dot < base.length - 1;
}
function unquotePath(text) {
  const first = text[0];
  const last = text[text.length - 1];
  if (text.length >= 2 && first === last && (first === '"' || first === "'" || first === "`")) {
    const inner = text.slice(1, -1);
    if (!inner.includes(first)) return { value: inner.trim(), quoted: true };
  }
  return { value: text, quoted: false };
}
function classifyPathText(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: "unknown", reason: "empty" };
  if (/[\r\n]/.test(trimmed)) return { kind: "unknown", reason: "multiline" };
  if (/\0|[\u0000-\u001f\u007f]/.test(trimmed)) return { kind: "unknown", reason: "prose" };
  const unquoted = unquotePath(trimmed);
  const value2 = unquoted.value;
  if (value2.length === 0) return { kind: "unknown", reason: "empty" };
  if (URL_TEXT.test(value2)) return { kind: "unknown", reason: "url" };
  if (!unquoted.quoted && GLOB_TEXT.test(value2)) return { kind: "unknown", reason: "glob" };
  if (!unquoted.quoted && /\s/.test(value2)) return { kind: "unknown", reason: "multiple" };
  const windows = WINDOWS_ABSOLUTE.test(value2);
  const posix = POSIX_ABSOLUTE.test(value2);
  const home = HOME_RELATIVE.test(value2);
  if (!windows && !posix && !home && !hasPathSignal(value2)) {
    return { kind: "unknown", reason: "prose" };
  }
  if (windows) return { kind: "path", path: value2, absolute: "windows" };
  if (posix) return { kind: "path", path: value2, absolute: "posix" };
  return { kind: "path", path: value2 };
}
function checkableOnHost(check, syntax) {
  return check.absolute === void 0 || check.absolute === syntax;
}
function keepsStaleFlag(entry, syntax) {
  if (entry.kind !== "path") return false;
  const check = classifyPathText(entry.text);
  return check.kind === "path" && checkableOnHost(check, syntax);
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
  const keeps = keepsStaleFlag(entry, hostPathSyntax());
  if (!keeps) delete entry.lastValidatedAt;
  if (raw.stale === true && keeps) entry.stale = true;
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
function emptyBucket() {
  return /* @__PURE__ */ Object.create(null);
}
function copyBucket(bucket) {
  const copy = emptyBucket();
  for (const key of Object.keys(bucket)) {
    const board = bucket[key];
    if (board !== void 0) copy[key] = board;
  }
  return copy;
}
function ownBoard(bucket, id) {
  return Object.hasOwn(bucket, id) ? bucket[id] : void 0;
}
function emptyStore() {
  return { version: 0, docs: { projects: emptyBucket(), sessions: emptyBucket() } };
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
    const docs = raw.docs;
    if (Object.hasOwn(docs, "global") && isRecord(docs.global)) store.docs.global = normalizeBoard(docs.global);
    for (const bucket of ["projects", "sessions"]) {
      if (!Object.hasOwn(docs, bucket)) continue;
      const value2 = docs[bucket];
      if (!isRecord(value2)) continue;
      const target = store.docs[bucket];
      for (const key of Object.keys(value2)) {
        const board = value2[key];
        if (key.length === 0 || !isRecord(board)) continue;
        target[key] = normalizeBoard(board);
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
  if (target.scope === "project") return ownBoard(store.docs.projects, target.projectId);
  return ownBoard(store.docs.sessions, target.sessionId);
}
function writeBoard(store, target, board) {
  const docs = {
    ...store.docs,
    projects: copyBucket(store.docs.projects),
    sessions: copyBucket(store.docs.sessions)
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
  if (facts.projectId !== void 0) layers.push({ scope: "project", board: ownBoard(store.docs.projects, facts.projectId) });
  if (facts.parentSessionId !== void 0 && facts.parentSessionId !== facts.sessionId) {
    layers.push({ scope: "session", board: ownBoard(store.docs.sessions, facts.parentSessionId) });
  }
  if (facts.sessionId !== void 0) layers.push({ scope: "session", board: ownBoard(store.docs.sessions, facts.sessionId) });
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
  if (facts.sessionId !== void 0 && has(ownBoard(store.docs.sessions, facts.sessionId))) {
    return { scope: "session", sessionId: facts.sessionId };
  }
  if (facts.parentSessionId !== void 0 && facts.parentSessionId !== facts.sessionId && has(ownBoard(store.docs.sessions, facts.parentSessionId))) {
    return { scope: "session", sessionId: facts.parentSessionId };
  }
  if (facts.projectId !== void 0 && has(ownBoard(store.docs.projects, facts.projectId))) {
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
  return `${WHITEBOARD_HEADER}
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
function lintPaths(doc, resolvePath, exists, now, syntax = hostPathSyntax()) {
  const stale = [];
  const unknown = [];
  const entries = doc.entries.map((entry) => {
    if (entry.kind !== "path") return entry;
    const check = classifyPathText(entry.text);
    if (check.kind === "unknown" || !checkableOnHost(check, syntax)) {
      const next2 = { ...entry };
      delete next2.stale;
      delete next2.lastValidatedAt;
      unknown.push(entry.id);
      return next2;
    }
    let resolved;
    try {
      resolved = resolvePath(entry, check.path);
    } catch {
      const next2 = { ...entry };
      delete next2.stale;
      delete next2.lastValidatedAt;
      unknown.push(entry.id);
      return next2;
    }
    if (resolved.length === 0) {
      const next2 = { ...entry };
      delete next2.stale;
      delete next2.lastValidatedAt;
      unknown.push(entry.id);
      return next2;
    }
    const present = exists(resolved);
    const next = { ...entry, lastValidatedAt: now };
    if (present) delete next.stale;
    else {
      next.stale = true;
      stale.push(entry.id);
    }
    return next;
  });
  return { doc: { ...doc, entries }, stale, unknown };
}
var ONE_PATH_REFUSAL = "path entries require exactly one filesystem path (no prose, lists, multiline text, URLs, or unquoted globs); quote a path containing spaces or glob metacharacters and use one entry per path";
function validatePathText(text) {
  return classifyPathText(text).kind === "path" ? void 0 : ONE_PATH_REFUSAL;
}
function applyWrites(board, requests, mode, now) {
  const entries = board.entries.map((entry) => ({ ...entry }));
  const changedIds = [];
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
      const pinned = request.pinned ?? previous.pinned;
      if (previous.kind === request.kind && previous.text === text && previous.pinned === pinned) continue;
      if (request.kind === "path" && (previous.kind !== "path" || previous.text !== text)) {
        const invalid = validatePathText(text);
        if (invalid !== void 0) return { ok: false, message: invalid };
      }
      const next = {
        id: id2,
        kind: request.kind,
        text,
        pinned,
        pinnedAt: request.pinned === true && previous.pinned !== true ? now : previous.pinnedAt,
        version: previous.version + 1
      };
      entries[index] = next;
      changedIds.push(id2);
      continue;
    }
    const id = typeof request.id === "string" && request.id.length > 0 ? request.id : `wb-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const duplicate = entries.find((entry) => entry.id === id);
    if (duplicate !== void 0) {
      if (duplicate.kind === request.kind && duplicate.text === text && (request.pinned === void 0 || request.pinned === duplicate.pinned)) continue;
      return { ok: false, message: `entry id "${id}" already exists \u2014 use mode "replace" to overwrite it` };
    }
    if (request.kind === "path") {
      const invalid = validatePathText(text);
      if (invalid !== void 0) return { ok: false, message: invalid };
    }
    entries.push({
      id,
      kind: request.kind,
      text,
      pinned: request.pinned === true,
      pinnedAt: request.pinned === true ? now : 0,
      version: 1
    });
    changedIds.push(id);
  }
  return { ok: true, board: { ...board, entries }, changedIds };
}
function applyStoreWrites(store, target, requests, mode, now) {
  const current = readBoard(store, target) ?? EMPTY_BOARD;
  const applied = applyWrites(current, requests, mode, now);
  if (!applied.ok) return applied;
  if (applied.changedIds.length === 0) return { ok: true, store, changedIds: [] };
  const board = { ...applied.board, version: current.version + 1, updatedAt: now };
  return { ok: true, store: writeBoard(store, target, board), changedIds: applied.changedIds };
}
function setPinned(board, id, pinned, now) {
  const index = board.entries.findIndex((entry) => entry.id === id);
  if (index === -1) return { ok: false, message: `no entry with id "${id}"` };
  const previous = board.entries[index];
  if (previous.pinned === pinned) return { ok: true, board, changed: false };
  const entries = board.entries.map((entry, at) => at === index ? { ...entry, pinned, pinnedAt: pinned ? now : entry.pinnedAt } : { ...entry });
  return { ok: true, board: { ...board, entries }, changed: true };
}
function setStorePinned(store, target, id, pinned, now) {
  const current = readBoard(store, target);
  if (current === void 0) return { ok: false, message: `no entry with id "${id}"` };
  const pinnedResult = setPinned(current, id, pinned, now);
  if (!pinnedResult.ok) return pinnedResult;
  if (!pinnedResult.changed) return { ok: true, store, changed: false };
  const board = { ...pinnedResult.board, version: current.version + 1, updatedAt: now };
  return { ok: true, store: writeBoard(store, target, board), changed: true };
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
    const leftAt = ownBoard(store.docs.sessions, left)?.updatedAt ?? 0;
    const rightAt = ownBoard(store.docs.sessions, right)?.updatedAt ?? 0;
    if (leftAt !== rightAt) return leftAt - rightAt;
    return left < right ? -1 : 1;
  });
  const dropped = ordered.slice(0, ids.length - Math.max(0, Math.floor(limit)));
  const sessions = copyBucket(store.docs.sessions);
  for (const id of dropped) delete sessions[id];
  return { store: { ...store, docs: { ...store.docs, sessions } }, dropped };
}
function versionLine(doc) {
  return `${WHITEBOARD_HEADER} v${doc.version} (${doc.scope}${doc.updatedAt > 0 ? ` \xB7 updated ${new Date(doc.updatedAt).toISOString()}` : ""})`;
}

// src/session-authority.ts
function classifySessionAuthority(header) {
  if (header === void 0 || header === null || typeof header !== "object" || Array.isArray(header)) {
    return { kind: "missing" };
  }
  const rawParent = header.parentSession;
  const hasParentField = rawParent !== void 0;
  const usableParent = typeof rawParent === "string" && rawParent.trim() !== "" ? rawParent : void 0;
  const rawOrigin = header.origin;
  const isSubagentOrigin = rawOrigin === "subagent";
  const hasUnexpectedOrigin = rawOrigin !== void 0 && !isSubagentOrigin;
  const rawDepth = header.delegationDepth;
  const isValidDepth = typeof rawDepth === "number" && Number.isSafeInteger(rawDepth) && rawDepth >= 0;
  const hasInvalidDepth = rawDepth !== void 0 && !isValidDepth;
  const hasPositiveDepth = isValidDepth && rawDepth > 0;
  const rawSeeded = header.isSeeded;
  const hasInvalidSeeded = rawSeeded !== void 0 && typeof rawSeeded !== "boolean";
  const depth = hasPositiveDepth ? rawDepth : 1;
  if (hasUnexpectedOrigin || hasInvalidDepth || hasInvalidSeeded) {
    return {
      kind: "delegated",
      ...usableParent !== void 0 ? { parentSessionId: usableParent } : {},
      depth,
      reason: "ambiguous session lineage"
    };
  }
  if (hasParentField && usableParent === void 0) {
    return {
      kind: "delegated",
      depth,
      reason: "unusable parentSession"
    };
  }
  if (isSubagentOrigin || hasPositiveDepth) {
    return {
      kind: "delegated",
      ...usableParent !== void 0 ? { parentSessionId: usableParent } : {},
      depth,
      reason: usableParent === void 0 ? isSubagentOrigin ? "subagent origin without usable parentSession" : "positive delegationDepth without usable parentSession" : isSubagentOrigin ? "subagent origin" : "positive delegationDepth"
    };
  }
  if (usableParent !== void 0) {
    if (rawSeeded === true) return { kind: "root" };
    return {
      kind: "delegated",
      parentSessionId: usableParent,
      depth,
      reason: "parentSession without seed lineage"
    };
  }
  return { kind: "root" };
}

// src/index.ts
var name = "enpoi-whiteboard";
var inject = ["tools"];
function live(schema) {
  return schema.volatile?.() ?? schema;
}
function value(field) {
  if (field === void 0) return void 0;
  if (typeof field === "number") return field;
  return field.get();
}
var Config = Schema.object({
  budgetTokens: live(Schema.number().default(DEFAULT_BUDGET_TOKENS)),
  maxSessionBoards: live(Schema.number().default(DEFAULT_MAX_SESSION_BOARDS))
});
function isJsonObject(value2) {
  return value2 !== null && typeof value2 === "object" && !Array.isArray(value2);
}
function isWhiteboardReadValue(value2) {
  return isJsonObject(value2) && value2.ok === true && Array.isArray(value2.entries) && Array.isArray(value2.stale) && Array.isArray(value2.unknown);
}
function isWhiteboardReceiptValue(value2) {
  return isJsonObject(value2) && value2.ok === true && typeof value2.op === "string" && Array.isArray(value2.changedIds);
}
function isWhiteboardRefusalValue(value2) {
  return isJsonObject(value2) && value2.ok === false && value2.reason === "refused" && typeof value2.message === "string";
}
function mutationRenderValue(value2) {
  if (isWhiteboardRefusalValue(value2) || isWhiteboardReceiptValue(value2)) return value2;
  throw new Error("whiteboard mutation rendered a value outside its output schema");
}
function readRenderValue(value2) {
  if (isWhiteboardReadValue(value2)) return value2;
  throw new Error("whiteboard_read rendered a value outside its output schema");
}
function forgetRenderValue(value2) {
  if (isWhiteboardRefusalValue(value2) || isWhiteboardReceiptValue(value2)) return value2;
  throw new Error("whiteboard_forget rendered a value outside its output schema");
}
var ORCH_NS = "enpoi-orchestration";
function settingsOf(ctx) {
  try {
    return ctx.get("settings");
  } catch {
    return void 0;
  }
}
var legacyReadLogged = false;
function isObjectRecord(value2) {
  return typeof value2 === "object" && value2 !== null && !Array.isArray(value2);
}
function storeFromDocument(document) {
  const migration = migrateLegacyStore(document?.whiteboard);
  if (migration.migrated && !legacyReadLogged) {
    legacyReadLogged = true;
    const destination = migration.attributedTo === void 0 ? "global" : `session ${migration.attributedTo}`;
    process.stderr.write(`[enpoi-whiteboard] legacy board read (${migration.entries} entries) \u2014 migrated in memory into ${destination}
`);
  }
  return migration.store;
}
function storeFromSettings(settings) {
  try {
    return storeFromDocument(readOrchestrationDocument(settings));
  } catch {
    return normalizeStore(void 0);
  }
}
function errorText(error) {
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}
function strictReadFailure(error) {
  return { ok: false, message: `board read failed \u2014 board not written (${errorText(error)})` };
}
function strictStoreFromSettings(settings) {
  if (settings === void 0) return { ok: false, message: "settings service unavailable \u2014 board not written" };
  let sawSurface = false;
  let revision;
  let document;
  let descriptor;
  if (typeof settings.describe === "function") {
    sawSurface = true;
    try {
      const entries = settings.describe();
      descriptor = entries.find((entry) => entry.ns === ORCH_NS);
      if (descriptor !== void 0) revision = descriptor.revision;
    } catch (error) {
      return strictReadFailure(error);
    }
  }
  if (descriptor?.value !== void 0) {
    if (!isObjectRecord(descriptor.value)) return { ok: false, message: "whiteboard document is malformed \u2014 board not written" };
    document = descriptor.value;
  } else {
    if (typeof settings.get === "function") {
      sawSurface = true;
      let value2;
      try {
        value2 = settings.get(ORCH_NS);
      } catch (error) {
        return strictReadFailure(error);
      }
      if (value2 !== void 0) {
        if (!isObjectRecord(value2)) return { ok: false, message: "whiteboard document is malformed \u2014 board not written" };
        document = value2;
      }
    }
    if (document === void 0 && typeof settings.describeNamespace === "function") {
      sawSurface = true;
      let narrow;
      try {
        narrow = settings.describeNamespace(ORCH_NS);
      } catch (error) {
        return strictReadFailure(error);
      }
      if (narrow?.value !== void 0) {
        if (!isObjectRecord(narrow.value)) return { ok: false, message: "whiteboard document is malformed \u2014 board not written" };
        document = narrow.value;
      }
    }
  }
  if (!sawSurface) return { ok: false, message: "settings service unavailable \u2014 board not written" };
  try {
    const raw = document?.whiteboard;
    if (raw !== void 0 && raw !== null && !isObjectRecord(raw)) {
      return { ok: false, message: "whiteboard document is malformed \u2014 board not written" };
    }
    return { ok: true, store: storeFromDocument(document), revision };
  } catch (error) {
    return strictReadFailure(error);
  }
}
function readWhiteboardStore(ctx) {
  return storeFromSettings(settingsOf(ctx));
}
function resolvedBoard(settings, facts = {}) {
  return resolveBoard(storeFromSettings(settings), facts);
}
function readWhiteboard(ctx, facts = {}) {
  return resolvedBoard(settingsOf(ctx), facts);
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
var MISSING_HEADER_AUTHORING_REFUSAL = "whiteboard authoring requires a trusted root session header";
function authoringDenial(exec) {
  const authority = classifySessionAuthority(exec?.agent?.session?.header);
  if (authority.kind === "root") return void 0;
  if (authority.kind === "missing") return refusal(MISSING_HEADER_AUTHORING_REFUSAL);
  return refusal(CHILD_AUTHORING_REFUSAL);
}
function resolveEntryPath(pathText, cwd) {
  if (pathText === "~") return homedir();
  if (pathText.startsWith("~/") || pathText.startsWith("~\\")) return resolve(homedir(), pathText.slice(2));
  return isAbsolute(pathText) ? pathText : resolve(cwd, pathText);
}
function linted(doc, exec, cwd = toolCwd(exec)) {
  return lintPaths(doc, (_entry, pathText) => resolveEntryPath(pathText, cwd), existsSync, Date.now());
}
function refusal(message, extra = {}) {
  return { ok: false, reason: "refused", message: safeMessage(message), ...extra };
}
async function commitStore(ctx, config, checkFacts, build) {
  const settings = settingsOf(ctx);
  if (settings?.mutate === void 0) return { ok: false, message: "settings service unavailable \u2014 board not written" };
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = Date.now();
    const strict = strictStoreFromSettings(settings);
    if (!strict.ok) return { ok: false, message: strict.message };
    const current = strict.store;
    const built = build(current, now);
    if (!built.ok) return { ok: false, message: built.message };
    if (built.changed === false) return { ok: true, store: current, changed: false, changedIds: [] };
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
    try {
      await settings.mutate(ORCH_NS, [{ op: "set", path: ["whiteboard"], value: next }], strict.revision);
      return { ok: true, store: next, changed: true, changedIds: built.changedIds ?? [] };
    } catch (error) {
      lastError = error;
      if (error?.code === "SETTINGS_CONFLICT" && attempt < 2) continue;
      return { ok: false, message: `board write failed: ${errorText(error)}` };
    }
  }
  return { ok: false, message: `board write failed after retries: ${errorText(lastError)}` };
}
var BOARD_RESULT_PROPERTIES = {
  ok: { type: "boolean" },
  reason: { type: "string" },
  message: { type: "string" },
  version: { type: "number" },
  scope: { type: "string" },
  checkedScope: { type: "string" },
  checkedFacts: { type: "object", additionalProperties: true },
  tokens: { type: "number" },
  budget: { type: "number" },
  callerTokens: { type: "number" },
  callerScope: { type: "string" },
  op: { type: "string" },
  changedIds: { type: "array", items: { type: "string" } },
  changedTotal: { type: "number" },
  entries: { type: "array", items: { type: "object", additionalProperties: true } },
  stale: { type: "array", items: { type: "string" } },
  staleTotal: { type: "number" },
  unknown: { type: "array", items: { type: "string" } },
  unknownTotal: { type: "number" },
  rendered: { type: "string" },
  versionLine: { type: "string" },
  note: { type: "string" }
};
var MAX_RECEIPT_IDS = 8;
var MAX_RECEIPT_CODEPOINTS = 600;
function takeChars(text, max) {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}
function boundText(text, max) {
  return Array.from(text).length <= max ? text : `${takeChars(text, max - 1)}\u2026`;
}
function escapeControls(text) {
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, (char) => {
    if (char === "\n") return "\\n";
    if (char === "\r") return "\\r";
    if (char === "	") return "\\t";
    const code = char.codePointAt(0) ?? 0;
    return `\\u${code.toString(16).padStart(4, "0")}`;
  });
}
function safeText(value2, max = MAX_RECEIPT_CODEPOINTS) {
  return boundText(escapeControls(String(value2)), max);
}
function safeMessage(message) {
  return safeText(message, MAX_RECEIPT_CODEPOINTS);
}
function boundedReceipt(text) {
  return boundText(text, MAX_RECEIPT_CODEPOINTS);
}
function boundedIds(ids, first = []) {
  const available = new Set(ids);
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const id of [...first, ...ids]) {
    if (!available.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_RECEIPT_IDS) break;
  }
  return out;
}
function boardView(stored, diagnostic, budgetTokens) {
  const rendered = renderWhiteboard(stored);
  const entries = diagnostic.doc.entries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    text: entry.text,
    pinned: entry.pinned,
    version: entry.version,
    scope: entry.scope,
    ...entry.stale === true ? { stale: true } : {}
  }));
  return {
    ok: true,
    version: stored.version,
    scope: stored.scope,
    tokens: estimateTokens(rendered),
    budget: budgetTokens,
    entries,
    stale: diagnostic.stale,
    staleTotal: diagnostic.stale.length,
    unknown: diagnostic.unknown,
    unknownTotal: diagnostic.unknown.length,
    rendered,
    versionLine: versionLine(stored)
  };
}
function receiptView(views, budgetTokens, op, changedIds, note) {
  const { checked, checkedFacts, checkedDiagnostics, caller } = views;
  return {
    ok: true,
    op,
    changedIds: boundedIds(changedIds),
    changedTotal: changedIds.length,
    version: checked.version,
    scope: caller.scope,
    checkedScope: checked.scope,
    checkedFacts,
    tokens: estimateTokens(renderWhiteboard(checked)),
    budget: budgetTokens,
    callerTokens: estimateTokens(renderWhiteboard(caller)),
    callerScope: caller.scope,
    stale: boundedIds(checkedDiagnostics.stale, changedIds),
    staleTotal: checkedDiagnostics.stale.length,
    unknown: boundedIds(checkedDiagnostics.unknown, changedIds),
    unknownTotal: checkedDiagnostics.unknown.length,
    ...note === void 0 ? {} : { note: safeText(note, 240) }
  };
}
function pathNote(staleTotal, unknownTotal) {
  const parts = [];
  if (staleTotal > 0) parts.push(`${staleTotal} stale path entr${staleTotal === 1 ? "y" : "ies"} (missing on disk; repoint or forget \u2014 never auto-deleted)`);
  if (unknownTotal > 0) parts.push(`${unknownTotal} path entr${unknownTotal === 1 ? "y" : "ies"} unverified (not one checkable path on this host; not stale)`);
  return parts.length === 0 ? void 0 : parts.join(" \xB7 ");
}
function writeTargetFor(exec, args) {
  const own = sessionFacts(exec);
  const ownCwd = toolCwd(exec);
  const scope = isWhiteboardScope(args.scope) ? args.scope : "session";
  if (scope === "global") return { target: { scope: "global" }, checkFacts: own, checkCwd: ownCwd };
  if (scope === "project") {
    const explicit2 = typeof args.projectId === "string" && args.projectId.length > 0 ? args.projectId : void 0;
    const projectId = explicit2 ?? ownCwd;
    const foreign = explicit2 !== void 0 && explicit2 !== ownCwd;
    return foreign ? { target: { scope: "project", projectId }, checkFacts: { projectId }, checkCwd: projectId } : { target: { scope: "project", projectId }, checkFacts: own, checkCwd: ownCwd };
  }
  const explicit = typeof args.sessionId === "string" && args.sessionId.length > 0 ? args.sessionId : void 0;
  const sessionId = explicit ?? own.sessionId;
  if (sessionId === void 0) return { error: 'scope "session" requires a session id and this execution has none' };
  return {
    target: { scope: "session", sessionId },
    checkFacts: sessionId === own.sessionId ? own : { sessionId },
    checkCwd: ownCwd
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
  if (tools === void 0) {
    process.stderr.write("[enpoi-whiteboard] no tools service \u2014 board tools not mounted\n");
    return;
  }
  tools.register({
    name: "whiteboard_read",
    description: [
      "Read the pinned context board resolved for this session: global entries, then this project's, then this session's (a direct child also inherits its parent session's), later scopes overriding earlier ones by entry id.",
      "Every entry reports the scope that authored it. This is the full view. `rendered` and `tokens` are the exact stored resolved injection; `entries`, `stale`, and `unknown` are live filesystem diagnostics and never change `rendered` or `tokens`. Mutations return only a short receipt."
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
          unknown: { type: "array", items: { type: "string" } },
          rendered: { type: "string" },
          versionLine: { type: "string" }
        },
        required: ["ok", "version", "scope", "tokens", "budget", "entries", "stale", "staleTotal", "unknown", "unknownTotal", "rendered", "versionLine"]
      },
      render: (_args, value2) => [{ type: "text", text: renderWhiteboardResult(readRenderValue(value2)) }]
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const stored = readWhiteboard(ctx, sessionFacts(exec));
      return boardView(stored, linted(stored, exec), config.budgetTokens);
    }
  });
  tools.register({
    name: "whiteboard_write",
    description: [
      "Author the pinned context board for one scope. scope defaults to session (your own session); project stores under your session cwd (or projectId) and applies to that project; global applies to every session.",
      "Append entries, or replace entries by id. A replace under the default session scope replaces the entry in the scope that authored it, so a project/global entry is replaced there. Repeating an identical id+content is a deterministic no-op: no entry version, board version, or injected-context change.",
      "Kinds: path, rule, fact, task. A path entry must contain exactly one filesystem path (absolute, cwd-relative, ~/\u2026, or a quoted path containing spaces; include a separator or file extension for bare names). Quoting makes glob metacharacters literal. Prose, path lists, multiline text, URLs, and unquoted globs are refused \u2014 use rule/fact/task for those. Missing paths are flagged stale, never deleted.",
      "Returns a short receipt (changed ids, checked stored-view tokens against the budget, checked scope/facts, caller-read tokens, board version, bounded stale/unverified ids), not the full board; use whiteboard_read for the full resolved view. The HARD budget is checked on the view the target can assemble: your full resolved view for global, default-project, and session writes; an explicit foreign project checks that project's view; an explicit foreign session checks that session. Other readers are not enumerated and no cwd catalog is persisted.",
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
      render: (_args, value2) => [{ type: "text", text: renderWriteResult(mutationRenderValue(value2)) }]
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const denied = authoringDenial(exec);
      if (denied !== void 0) return denied;
      const mode = args.mode === "replace" ? "replace" : "append";
      const rawEntries = args.entries;
      if (!Array.isArray(rawEntries) || rawEntries.length === 0) return refusal("entries must be a non-empty array");
      const requests = [];
      for (const raw of rawEntries) {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
          return refusal("entries[] must contain objects");
        }
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
        const changedIds = [];
        for (const group of plan.groups) {
          const applied = applyStoreWrites(next, group.target, group.requests, mode, now);
          if (!applied.ok) return applied;
          if (applied.changedIds.length === 0) continue;
          for (const id of applied.changedIds) if (!changedIds.includes(id)) changedIds.push(id);
          const board = readBoard(applied.store, group.target);
          const lintCwd = group.target.scope === "project" ? group.target.projectId : void 0;
          next = board === void 0 ? applied.store : writeBoard(applied.store, group.target, linted(board, exec, lintCwd).doc);
        }
        return { ok: true, store: next, changed: changedIds.length > 0, changedIds };
      });
      if (!committed.ok) return refusal(committed.message, committed.tokens === void 0 ? {} : { tokens: committed.tokens, budget: committed.budget });
      const caller = resolveBoard(committed.store, facts);
      const checked = resolveBoard(committed.store, target.checkFacts);
      const checkedView = linted(checked, exec, target.checkCwd);
      const note = committed.changed ? pathNote(checkedView.stale.length, checkedView.unknown.length) : void 0;
      return receiptView(
        { checked, checkedFacts: target.checkFacts, checkedDiagnostics: checkedView, caller },
        config.budgetTokens,
        committed.changed ? mode : "unchanged",
        committed.changedIds,
        note
      );
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
      render: (_args, value2) => [{ type: "text", text: renderWriteResult(mutationRenderValue(value2)) }]
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const denied = authoringDenial(exec);
      if (denied !== void 0) return denied;
      const id = typeof args.id === "string" ? args.id : "";
      if (id.length === 0) return refusal("id is required");
      const facts = sessionFacts(exec);
      const committed = await commitStore(ctx, config, facts, (store, now) => {
        const target = findEntryTarget(store, facts, id);
        if (target === void 0) return { ok: false, message: `no entry with id "${id}" in this session's resolved board` };
        const pinned = setStorePinned(store, target, id, true, now);
        return pinned.ok ? { ok: true, store: pinned.store, changed: pinned.changed, changedIds: pinned.changed ? [id] : [] } : pinned;
      });
      if (!committed.ok) return refusal(committed.message, committed.tokens === void 0 ? {} : { tokens: committed.tokens, budget: committed.budget });
      const caller = resolveBoard(committed.store, facts);
      const view = linted(caller, exec);
      return receiptView(
        { checked: caller, checkedFacts: facts, checkedDiagnostics: view, caller },
        config.budgetTokens,
        "pin",
        committed.changedIds,
        committed.changed ? void 0 : `already pinned ${id}`
      );
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
      render: (_args, value2) => [{ type: "text", text: renderWriteResult(mutationRenderValue(value2)) }]
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const denied = authoringDenial(exec);
      if (denied !== void 0) return denied;
      const id = typeof args.id === "string" ? args.id : "";
      if (id.length === 0) return refusal("id is required");
      const facts = sessionFacts(exec);
      const committed = await commitStore(ctx, config, facts, (store, now) => {
        const target = findEntryTarget(store, facts, id);
        if (target === void 0) return { ok: false, message: `no entry with id "${id}" in this session's resolved board` };
        const pinned = setStorePinned(store, target, id, false, now);
        return pinned.ok ? { ok: true, store: pinned.store, changed: pinned.changed, changedIds: pinned.changed ? [id] : [] } : pinned;
      });
      if (!committed.ok) return refusal(committed.message, committed.tokens === void 0 ? {} : { tokens: committed.tokens, budget: committed.budget });
      const caller = resolveBoard(committed.store, facts);
      const view = linted(caller, exec);
      return receiptView(
        { checked: caller, checkedFacts: facts, checkedDiagnostics: view, caller },
        config.budgetTokens,
        "unpin",
        committed.changedIds,
        committed.changed ? void 0 : `already unpinned ${id}`
      );
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
      render: (_args, value2) => [{ type: "text", text: renderForgetResult(forgetRenderValue(value2)) }]
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const denied = authoringDenial(exec);
      if (denied !== void 0) return denied;
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
        return { ok: true, store: result.store, changed: true, changedIds: [id] };
      });
      if (!committed.ok) return refusal(committed.message, committed.tokens === void 0 ? {} : { tokens: committed.tokens, budget: committed.budget });
      const caller = resolveBoard(committed.store, facts);
      const view = linted(caller, exec);
      const base = receiptView(
        { checked: caller, checkedFacts: facts, checkedDiagnostics: view, caller },
        config.budgetTokens,
        "forget",
        committed.changedIds,
        `forgot ${id}`
      );
      return removed === void 0 ? base : { ...base, removed };
    }
  });
}
function shortId(id) {
  return safeText(id, 32);
}
function renderIdList(value2, total) {
  const ids = Array.isArray(value2) ? value2.filter((id) => typeof id === "string") : [];
  const shown = ids.map(shortId).join(", ");
  return total > ids.length ? `${shown}${shown.length > 0 ? " " : ""}(+${total - ids.length} more)` : shown;
}
function renderWhiteboardResult(value2) {
  const entries = value2.entries;
  const unknown = value2.unknown;
  const warning = unknown.length > 0 ? `
Unverified path entries (not stale): ${unknown.map((id) => escapeControls(String(id))).join(", ")}` : "";
  const scope = safeText(value2.scope, 24);
  if (entries.length === 0) return `Whiteboard v${String(value2.version)} resolves to no entries for this session (0/${String(value2.budget)} tokens).${warning}`;
  const lines = entries.map((entry) => `\u2022 ${entry.pinned === true ? "\u{1F4CC} " : ""}[${safeText(entry.kind, 16)}] ${String(entry.text)}${entry.stale === true ? " (stale)" : ""} \u2014 ${escapeControls(String(entry.id))} v${String(entry.version)} \xB7 ${safeText(entry.scope, 24)}`);
  return `${[...lines, `\u2014 v${String(value2.version)} \xB7 ${scope} \xB7 ${String(value2.tokens)}/${String(value2.budget)} tokens`].join("\n")}${warning}`;
}
function renderReceipt(value2) {
  if (value2.ok !== true) return safeMessage(String(value2.message ?? "Whiteboard mutation refused."));
  const op = safeText(typeof value2.op === "string" ? value2.op : "write", 24);
  const changedTotal = typeof value2.changedTotal === "number" ? value2.changedTotal : 0;
  const staleTotal = typeof value2.staleTotal === "number" ? value2.staleTotal : 0;
  const unknownTotal = typeof value2.unknownTotal === "number" ? value2.unknownTotal : 0;
  const tokens = typeof value2.tokens === "number" ? value2.tokens : 0;
  const callerTokens = typeof value2.callerTokens === "number" ? value2.callerTokens : tokens;
  const callerScope = safeText(value2.scope, 32);
  const checkedScope = safeText(typeof value2.checkedScope === "string" ? value2.checkedScope : value2.scope, 32);
  const head = checkedScope === callerScope && callerTokens === tokens ? `Whiteboard v${String(value2.version)} \xB7 ${callerScope} \xB7 ${String(tokens)}/${String(value2.budget)} tokens` : `Whiteboard v${String(value2.version)} \xB7 read ${callerScope} ${String(callerTokens)} tok \xB7 checked ${checkedScope} ${String(tokens)}/${String(value2.budget)} tok`;
  const action = op === "unchanged" ? "unchanged (identical content; no version or injection change)" : `${op}: ${changedTotal === 0 ? "none" : renderIdList(value2.changedIds, changedTotal)}`;
  const flags = [];
  if (staleTotal > 0) flags.push(`stale ${staleTotal}: ${renderIdList(value2.stale, staleTotal)}`);
  if (unknownTotal > 0) flags.push(`unverified path ${unknownTotal}: ${renderIdList(value2.unknown, unknownTotal)}`);
  const lines = [head, [action, ...flags].filter((part) => part.length > 0).join(" \xB7 ")];
  const note = typeof value2.note === "string" && value2.note.length > 0 ? safeText(value2.note, 240) : void 0;
  if (note !== void 0) lines.push(note);
  return boundedReceipt(lines.join("\n"));
}
function renderWriteResult(value2) {
  return renderReceipt(value2);
}
function renderForgetResult(value2) {
  if (value2.ok !== true) return safeMessage(String(value2.message ?? "Whiteboard forget refused."));
  const removed = value2.removed;
  const display = removed === void 0 ? "" : safeText(removed.text, 240);
  const head = removed === void 0 ? "Whiteboard entry forgotten." : `Forgot [${safeText(removed.kind, 16)}] ${display} \u2014 ${shortId(removed.id)} (${safeText(removed.scope, 24)}).`;
  return boundedReceipt(`${head}
${renderReceipt({ ...value2, op: "forget", note: void 0 })}`);
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
  readWhiteboardStore,
  resolvedBoard
};
