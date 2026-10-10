// src/index.ts
import Schema from "@deepseek-ai/schemastery";
import { randomUUID } from "node:crypto";
import { dirname as dirname2 } from "node:path";

// src/asks.ts
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
function askLabel(alias, sessionId, ask) {
  const what = ask.kind === "approval" ? `approval for tool "${ask.toolName ?? "unknown"}"` : `a user question${ask.questions?.[0] === void 0 ? "" : ` ("${ask.questions[0].question}")`}`;
  const why = ask.reason === void 0 || ask.reason === "" ? "" : ` \u2014 ${ask.reason}`;
  return `remote ask on ${alias} (${sessionId}): ${what}${why}`;
}
function localDecisionToPeerAnswer(decision) {
  switch (decision) {
    case "allowed-once":
      return { outcome: "allowed-once", note: "local operator approved once \u2192 relayed as allowed-once" };
    case "rejected":
      return { outcome: "rejected", note: "local operator rejected \u2192 relayed as rejected" };
    case "cancelled":
      return { note: "local approval was withdrawn/cancelled \u2014 remote ask left unanswered" };
    case "unavailable":
      return { note: "local approval channel unavailable (no answerer/timeout) \u2014 remote ask left unanswered" };
    case "unsurfaced":
      return { note: "local approval service unavailable \u2014 ask recorded as a durable notice and left answerable via peer_answer" };
  }
}
function askSummary(ask) {
  if (ask.kind === "approval") {
    const reason = ask.reason === void 0 || ask.reason === "" ? "" : ` (${ask.reason})`;
    return `approval ${ask.askId} tool=${ask.toolName ?? "unknown"}${reason}`;
  }
  const questions = ask.questions ?? [];
  const rendered = questions.map(renderQuestion).join("; ");
  return `question ${ask.askId} (${String(questions.length)} item${questions.length === 1 ? "" : "s"})${rendered === "" ? "" : `: ${rendered}`}`;
}
function renderQuestion(question) {
  const options = (question.options ?? []).map((option) => option.label).join(", ");
  const multi = question.multiSelect === true ? " multi" : "";
  return `"${question.question}" (id=${question.id}${multi}${options === "" ? "" : `; options: ${options}`})`;
}
function normalizeQuestionSelections(questions, selections) {
  if (questions.length === 0) return { ok: false, message: "the question ask carries no questions" };
  if (selections.length === 0) return { ok: false, message: "no selected labels were provided (use --select <label> or an answers[] entry)" };
  const byId = new Map(questions.map((question) => [question.id, question]));
  const answers = [];
  for (const selection of selections) {
    const question = byId.get(selection.id);
    if (question === void 0) {
      return { ok: false, message: `unknown question id ${JSON.stringify(selection.id)}; the ask has ${questions.map((item) => item.id).join(", ")}` };
    }
    if (answers.some((answer) => answer.id === selection.id)) {
      return { ok: false, message: `question ${JSON.stringify(selection.id)} was selected twice` };
    }
    if (selection.selected.length === 0) {
      return { ok: false, message: `question ${JSON.stringify(selection.id)} has no selected label` };
    }
    if (question.multiSelect !== true && selection.selected.length > 1) {
      return { ok: false, message: `question ${JSON.stringify(selection.id)} is single-select but got ${String(selection.selected.length)} labels` };
    }
    const labels = (question.options ?? []).map((option) => option.label);
    for (const label of selection.selected) {
      if (labels.length > 0 && !labels.includes(label)) {
        return { ok: false, message: `${JSON.stringify(label)} is not an option of question ${JSON.stringify(selection.id)} (options: ${labels.join(", ")})` };
      }
      if (selection.selected.filter((candidate) => candidate === label).length > 1) {
        return { ok: false, message: `${JSON.stringify(label)} was selected twice for question ${JSON.stringify(selection.id)}` };
      }
    }
    answers.push({
      id: selection.id,
      selected: [...selection.selected],
      ...selection.custom === void 0 || selection.custom === "" ? {} : { custom: selection.custom }
    });
  }
  const unanswered = questions.filter((question) => !answers.some((answer) => answer.id === question.id));
  if (unanswered.length > 0) {
    return { ok: false, message: `question${unanswered.length === 1 ? "" : "s"} ${unanswered.map((question) => JSON.stringify(question.id)).join(", ")} not answered` };
  }
  return { ok: true, answer: { answers } };
}
function appendAskNotice(path, notice) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(notice)}
`, { mode: 384 });
  } catch {
  }
}
function defaultNoticesPath(dshHome) {
  return `${dshHome.replace(/\/+$/u, "")}/peer-bridge/asks.jsonl`;
}

// src/peer-client.ts
var PeerBridgeError = class extends Error {
  /** Stable peer error code (`peer/*`, `gateway/*`). */
  code;
  /** Structured details from the host envelope. */
  details;
  /** Endpoint the failing call targeted. */
  endpoint;
  /**
   * @param code - stable error code.
   * @param message - human-readable failure.
   * @param endpoint - target base URL.
   * @param details - structured details.
   */
  constructor(code, message, endpoint, details = {}) {
    super(message);
    this.name = "PeerBridgeError";
    this.code = code;
    this.details = details;
    this.endpoint = endpoint;
  }
};
var DEFAULT_BACKOFF = { initialMs: 250, maxMs: 4e3, factor: 2 };
var REPAIR_PAGE_LIMIT = 20;
var CALLER_TERMINAL_CODES = /* @__PURE__ */ new Set([
  "peer/version-skew",
  "peer/not-paired",
  "peer/not-found",
  "peer/forbidden"
]);
var PeerClient = class {
  /**
   * @param options - target endpoint, identity, and carrier replacements.
   */
  constructor(options) {
    this.options = options;
    this.endpoint = options.endpoint.replace(/\/+$/u, "");
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.webSocketFactory = options.webSocket ?? defaultWebSocket;
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.maxReconnects = options.maxReconnects;
    this.pageSize = options.pageSize ?? 50;
  }
  endpoint;
  headers;
  fetchImpl;
  webSocketFactory;
  backoff;
  maxReconnects;
  pageSize;
  /** Negotiate against the target; a protocol mismatch surfaces `peer/version-skew`. */
  async handshake() {
    return this.rpc("handshake", {
      protocolVersion: 1,
      harnessVersion: this.options.harnessVersion ?? "0.1.6-alpha.2",
      schemaDigest: this.options.schemaDigest ?? "",
      device: this.options.device
    });
  }
  /** Read the latch for one target. */
  state(target) {
    return this.rpc("state", { target });
  }
  /** List the pairings the host exposes, optionally narrowed to one resolved target. */
  list(request = {}) {
    return this.rpc("list", request);
  }
  /** Create or adopt a Session under a pairing alias. */
  create(request) {
    return this.rpc("create", request);
  }
  /** Admit a queued peer turn. */
  prompt(request) {
    return this.rpc("prompt", request);
  }
  /** Cancel the target's active turn. */
  cancel(request) {
    return this.rpc("cancel", request);
  }
  /** Settle a pending ask. */
  answer(request) {
    return this.rpc("answer", request);
  }
  /** Read one backwards history window for repair. */
  page(request) {
    return this.rpc("page", request);
  }
  /**
   * Open one follow generation without reconnect handling.
   * @param request - target and window options.
   * @param signal - caller cancellation closing the socket.
   * @returns frames exactly as the host sends them.
   */
  async *followOnce(request, signal) {
    const socket = this.webSocketFactory(this.muxUrl());
    const streamId = `peer-${randomToken()}`;
    const queue = [];
    let wake;
    let closed = false;
    const notify = () => {
      wake?.();
      wake = void 0;
    };
    const onMessage = (event) => {
      const text = messageText(event);
      if (text === void 0) return;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      if (typeof parsed !== "object" || parsed === null) return;
      const frame = parsed;
      if (frame.streamId !== streamId || typeof frame.type !== "string") return;
      queue.push(frame);
      notify();
    };
    const onClose = () => {
      closed = true;
      notify();
    };
    const isClosed = () => closed;
    const onAbort = () => {
      closed = true;
      notify();
      socket.close();
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await new Promise((resolve, reject) => {
        const onOpen = () => {
          socket.removeEventListener("open", onOpen);
          socket.send(JSON.stringify({
            type: "open",
            streamId,
            endpoint: "peer/follow",
            payload: { args: { request } }
          }));
          resolve();
        };
        const onOpenError = () => {
          socket.removeEventListener("error", onOpenError);
          reject(unreachable(this.endpoint));
        };
        socket.addEventListener("open", onOpen);
        socket.addEventListener("error", onOpenError);
      });
      while (true) {
        const frame = queue.shift();
        if (frame === void 0) {
          if (isClosed()) return;
          await new Promise((resolve) => {
            wake = resolve;
          });
          continue;
        }
        if (frame.type === "item") {
          yield frame.value;
          continue;
        }
        if (frame.type === "error") {
          throw decodeFailure(frame.value, this.endpoint);
        }
        return;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.close();
      if (queue.length > 0) queue.length = 0;
    }
  }
  /**
   * Stream frames with automatic reconnect and durable-hole repair.
   * @param request - target and window options.
   * @param signal - caller cancellation; the only way to stop a healthy stream.
   * @returns follow frames across reconnects; repair records precede the new snapshot.
   */
  async *follow(request, signal) {
    let lastCursor;
    let attempt = 0;
    while (!signal.aborted) {
      let progressed = false;
      try {
        for await (const frame of this.followOnce(request, signal)) {
          progressed = true;
          if (frame.type === "snapshot") {
            if (lastCursor !== void 0 && frame.records.length > 0) {
              const oldest = frame.records[0]?.seq;
              if (oldest !== void 0 && oldest > lastCursor + 1) {
                yield* this.repairForward(request.target, lastCursor, oldest, signal);
              }
            }
            lastCursor = frame.cursor;
          } else if (frame.type === "event") {
            lastCursor = Math.max(lastCursor ?? -1, frame.record.seq);
          } else if (frame.type === "state") {
            lastCursor = Math.max(lastCursor ?? -1, frame.cursor);
          }
          yield frame;
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof PeerBridgeError && CALLER_TERMINAL_CODES.has(error.code)) throw error;
      }
      if (signal.aborted) return;
      attempt = progressed ? 1 : attempt + 1;
      if (this.maxReconnects !== void 0 && attempt > this.maxReconnects) {
        throw unreachable(this.endpoint);
      }
      await delay(backoffDelay(this.backoff, attempt), signal);
    }
  }
  /**
   * Fill a durable hole between two cursors by paging backwards from the newer cut.
   * A hole the pages cannot prove contiguous emits `onWarning` with the missing range.
   * @param target - resolved peer target.
   * @param fromExclusive - last durable seq the caller already folded.
   * @param toExclusive - first durable seq the caller is about to receive.
   * @param signal - caller cancellation.
   * @returns the missing records in ascending seq order.
   */
  async *repairForward(target, fromExclusive, toExclusive, signal) {
    const collected = [];
    let throughSeq = toExclusive - 1;
    let hole;
    let pages = 0;
    while (pages < REPAIR_PAGE_LIMIT) {
      if (signal.aborted || throughSeq <= fromExclusive) break;
      const value = await this.page({ target, throughSeq, maxMessages: this.pageSize });
      pages += 1;
      if (value.records.length === 0) {
        hole = { from: fromExclusive + 1, to: throughSeq + 1 };
        break;
      }
      for (const record of value.records) {
        if (record.seq > fromExclusive && record.seq < toExclusive) collected.push(record);
      }
      const oldest = value.records[0]?.seq;
      if (oldest === void 0 || oldest <= fromExclusive + 1 || !value.hasMore) {
        if (oldest !== void 0 && oldest > fromExclusive + 1) hole = { from: fromExclusive + 1, to: oldest };
        break;
      }
      throughSeq = oldest - 1;
    }
    if (hole === void 0 && !signal.aborted && throughSeq > fromExclusive) {
      hole = { from: fromExclusive + 1, to: throughSeq + 1 };
    }
    if (hole !== void 0) this.options.onWarning?.(hole);
    collected.sort((left, right) => left.seq - right.seq);
    for (const record of collected) yield { type: "event", record, cursor: record.seq };
  }
  async rpc(method, args) {
    const endpoint = `${this.endpoint}/api/peer/${method}`;
    let response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.headers },
        body: JSON.stringify({
          type: "client-request",
          rpcId: `peer-${randomToken()}`,
          method: `peer/${method}`,
          // SRC-derived host descriptors name the business parameter `request`.
          payload: { args: { request: args } }
        })
      });
    } catch (error) {
      throw unreachable(this.endpoint, error);
    }
    if (!response.ok) {
      throw new PeerBridgeError("peer/target-unreachable", `peer ${method} failed over HTTP ${String(response.status)}`, this.endpoint, { endpoint: this.endpoint });
    }
    const body = await response.json();
    const result = body.result;
    if (result === void 0) {
      throw new PeerBridgeError("gateway/internal", `peer ${method} returned no result envelope`, this.endpoint, {});
    }
    if (result.ok) return result.value;
    throw decodeFailure(result.error, this.endpoint);
  }
  muxUrl() {
    const url = new URL(this.endpoint);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/api/remote.mux";
    url.search = "";
    return url.toString();
  }
};
function unreachable(endpoint, cause) {
  const error = new PeerBridgeError("peer/target-unreachable", `peer target ${endpoint} is unreachable`, endpoint, { endpoint });
  if (cause !== void 0) error.cause = cause;
  return error;
}
function decodeFailure(value, endpoint) {
  if (typeof value !== "object" || value === null) return unreachable(endpoint);
  const record = value;
  const code = typeof record.code === "string" ? record.code : "gateway/internal";
  const message = typeof record.message === "string" ? record.message : "peer call failed";
  const details = typeof record.details === "object" && record.details !== null ? record.details : {};
  return new PeerBridgeError(code, message, endpoint, details);
}
function defaultWebSocket(url) {
  const ctor = Reflect.get(globalThis, "WebSocket");
  if (ctor === void 0) throw new Error("peer client: no global WebSocket; inject one through PeerClientOptions.webSocket");
  return new ctor(url);
}
function messageText(event) {
  if (typeof event === "string") return event;
  if (typeof event !== "object" || event === null) return void 0;
  const data = Reflect.get(event, "data");
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  return void 0;
}
function randomToken() {
  return globalThis.crypto.randomUUID();
}
function backoffDelay(backoff, attempt) {
  const scaled = backoff.initialMs * backoff.factor ** Math.max(0, attempt - 1);
  return Math.min(backoff.maxMs, Math.round(scaled));
}
function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// src/follow.ts
var DEFAULT_SETTLE_QUIET_MS = 2e3;
function isPeerSessionSettled(state) {
  if (state === void 0 || state.terminal === void 0) return false;
  if ((state.pendingAskCount ?? 0) > 0) return false;
  if ((state.activeDescendants ?? 0) > 0) return false;
  if (state.descendantsExact === false) return false;
  return state.latch === void 0 || state.latch === "unknown" || state.latch === "idle";
}
function recordRpcId(record) {
  if (record.type !== "user/message") return void 0;
  const source = field(record.data, "source");
  const rpcId = field(source, "rpcId");
  return typeof rpcId === "string" ? rpcId : void 0;
}
function recordTurn(record) {
  const turn = field(record.data, "turn");
  return typeof turn === "number" && Number.isFinite(turn) ? turn : void 0;
}
function recordTerminal(record) {
  if (record.type !== "turn/end") return void 0;
  const turn = recordTurn(record);
  if (turn === void 0) return void 0;
  const reason = field(record.data, "reason");
  const kind = field(reason, "kind");
  const error = field(reason, "error");
  return {
    turn,
    reason: typeof kind === "string" ? kind : "unknown",
    ...error === void 0 ? {} : { error }
  };
}
function recordAssistantText(record) {
  if (record.type !== "assistant/message") return "";
  const message = field(record.data, "message");
  return contentText(field(message, "content"));
}
function contentText(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    const text = field(block, "text");
    if (field(block, "type") === "text" && typeof text === "string") parts.push(text);
  }
  return parts.join("\n");
}
function recordSourceKind(record) {
  if (record.type !== "user/message") return void 0;
  const kind = field(field(record.data, "source"), "kind");
  return typeof kind === "string" ? kind : void 0;
}
function field(value, key) {
  if (typeof value !== "object" || value === null) return void 0;
  return value[key];
}

// src/pairings.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function defaultPairingsPath(env = process.env) {
  const home = env.DSH_HOME !== void 0 && env.DSH_HOME !== "" ? env.DSH_HOME : join(homedir(), ".dsh");
  return join(home, "pairings.yaml");
}
var PairingDocumentError = class extends Error {
  /** Line number (1-based) the failure points at; 0 when the document is empty. */
  line;
  /**
   * @param message - human-readable failure.
   * @param line - source line, 1-based.
   */
  constructor(message, line) {
    super(line > 0 ? `${message} (line ${String(line)})` : message);
    this.name = "PairingDocumentError";
    this.line = line;
  }
};
function parsePairingDocument(raw, path) {
  const lines = significantLines(raw);
  if (lines.length === 0) throw new PairingDocumentError(`peer pairings ${path} is empty`, 0);
  const [document, next] = parseBlock(lines, 0, lines[0].indent);
  if (next !== lines.length) {
    throw new PairingDocumentError(`peer pairings ${path} has trailing content`, lines[next].line);
  }
  if (!isRecord(document)) throw new PairingDocumentError(`peer pairings ${path} must be a mapping`, 1);
  if (document.version !== 1) throw new PairingDocumentError(`peer pairings ${path} must declare version: 1`, 1);
  const device = requireNonEmptyString(document.device, `${path}: device`);
  const rawList = document.pairings;
  if (!Array.isArray(rawList)) throw new PairingDocumentError(`peer pairings ${path} must declare a pairings list`, 1);
  const pairings = [];
  for (const [index, entry] of rawList.entries()) {
    if (!isRecord(entry)) throw new PairingDocumentError(`${path}: pairings[${index}] must be a mapping`, 1);
    pairings.push(parseEntry(entry, `${path}#pairings[${index}]`));
  }
  return { version: 1, device, pairings };
}
function readPairingDocument(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new PairingDocumentError(
      `peer pairings ${path} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      0
    );
  }
  const stripped = raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw;
  return parsePairingDocument(stripped, path);
}
function callerPairings(document) {
  return document.pairings.filter((pairing) => pairing.endpoint !== void 0);
}
function describeCallerPairings(callers) {
  return callers.length === 0 ? "no caller-role entries (an entry needs `endpoint` and `peer`)" : `available: ${callers.map((pairing) => `${pairing.alias} \u2192 ${pairing.peer}`).join(", ")}`;
}
function resolveCallerPairing(document, alias) {
  const callers = callerPairings(document);
  const found = callers.find((pairing) => pairing.alias === alias);
  if (found !== void 0) return found;
  throw new PairingDocumentError(
    `no caller-role pairing with alias ${JSON.stringify(alias)}; ${describeCallerPairings(callers)}`,
    0
  );
}
function loadCallerPairing(path, alias) {
  const document = readPairingDocument(path);
  return { document, pairing: resolveCallerPairing(document, alias) };
}
var ALIAS_PATTERN = /^[A-Za-z0-9._-]+$/;
function parseEntry(entry, subject) {
  const alias = requireNonEmptyString(entry.alias, `${subject}: alias`);
  if (!ALIAS_PATTERN.test(alias)) {
    throw new PairingDocumentError(`${subject}: alias must match [A-Za-z0-9._-]+ (received ${JSON.stringify(alias)})`, 1);
  }
  const peer = requireNonEmptyString(entry.peer, `${subject}: peer`);
  const endpoint = typeof entry.endpoint === "string" && entry.endpoint !== "" ? entry.endpoint : void 0;
  if (endpoint !== void 0 && !/^https?:\/\//u.test(endpoint)) {
    throw new PairingDocumentError(`${subject}: endpoint must be an http(s) URL (received ${JSON.stringify(endpoint)})`, 1);
  }
  const optionalString = (key) => {
    const value = entry[key];
    if (value === void 0 || value === null) return void 0;
    if (typeof value !== "string" || value === "") {
      throw new PairingDocumentError(`${subject}: ${key} must be a non-empty string when present`, 1);
    }
    return value;
  };
  const create = entry.create === void 0 || entry.create === null ? void 0 : isRecord(entry.create) ? entry.create : (() => {
    throw new PairingDocumentError(`${subject}: create must be a mapping`, 1);
  })();
  const createRouting = parseCreateRouting(create, subject);
  const runawayCeiling = entry.runawayCeiling === void 0 || entry.runawayCeiling === null ? void 0 : typeof entry.runawayCeiling === "number" && Number.isFinite(entry.runawayCeiling) && entry.runawayCeiling > 0 ? entry.runawayCeiling : (() => {
    throw new PairingDocumentError(`${subject}: runawayCeiling must be a positive number`, 1);
  })();
  const exposure = optionalString("exposure");
  if (exposure !== void 0 && exposure !== "answer-only" && exposure !== "debug") {
    throw new PairingDocumentError(`${subject}: exposure must be answer-only or debug (received ${JSON.stringify(exposure)})`, 1);
  }
  return {
    alias,
    peer,
    ...endpoint === void 0 ? {} : { endpoint },
    ...exposure === void 0 ? {} : { exposure },
    ...optionalString("token") === void 0 ? {} : { token: optionalString("token") },
    ...optionalString("remoteSessionId") === void 0 ? {} : { remoteSessionId: optionalString("remoteSessionId") },
    ...optionalString("sessionId") === void 0 ? {} : { sessionId: optionalString("sessionId") },
    ...create === void 0 ? {} : { create },
    ...createRouting === void 0 ? {} : { createRouting },
    ...runawayCeiling === void 0 ? {} : { runawayCeiling }
  };
}
function parseCreateRouting(create, subject) {
  if (create === void 0) return void 0;
  const provider = createField(create, "provider", subject);
  const model = createField(create, "model", subject);
  if (provider === void 0 && model === void 0) return void 0;
  if (provider === void 0 || model === void 0) {
    throw new PairingDocumentError(`${subject}: create.provider and create.model must be provided together`, 1);
  }
  const chain = createField(create, "chain", subject);
  const reasoningEffort = createField(create, "reasoningEffort", subject);
  return {
    provider,
    model,
    ...chain === void 0 ? {} : { chain },
    ...reasoningEffort === void 0 ? {} : { reasoningEffort }
  };
}
function createField(create, key, subject) {
  const value = create[key];
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "string" || value === "") {
    throw new PairingDocumentError(`${subject}: create.${key} must be a non-empty string when present`, 1);
  }
  return value;
}
function requireNonEmptyString(value, subject) {
  if (typeof value !== "string" || value === "") {
    throw new PairingDocumentError(`${subject} must be a non-empty string`, 1);
  }
  return value;
}
function significantLines(raw) {
  const out = [];
  const rows = raw.split(/\r?\n/u);
  for (const [index, row] of rows.entries()) {
    const text = stripComment(row);
    if (text.trim() === "") continue;
    out.push({
      indent: text.length - text.trimStart().length,
      text: text.trim(),
      line: index + 1
    });
  }
  return out;
}
function stripComment(raw) {
  let quote;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (quote !== void 0) {
      if (char === quote) quote = void 0;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/u.test(raw[index - 1]))) return raw.slice(0, index);
  }
  return raw;
}
function parseBlock(lines, start, indent) {
  const first = lines[start];
  if (first === void 0) return [null, start];
  if (first.indent < indent) return [null, start];
  if (isSequenceLine(first.text)) return parseSequence(lines, start, first.indent);
  return parseMapping(lines, start, first.indent);
}
function isSequenceLine(text) {
  return text === "-" || text.startsWith("- ");
}
function parseMapping(lines, start, indent, firstPair) {
  const out = {};
  let index = start;
  let pending = firstPair;
  while (true) {
    let text;
    let line;
    if (pending !== void 0) {
      text = pending.text;
      line = pending.line;
      pending = void 0;
    } else {
      const current = lines[index];
      if (current === void 0 || current.indent !== indent || isSequenceLine(current.text)) break;
      text = current.text;
      line = current.line;
      index += 1;
    }
    const colon = findColon(text);
    if (colon < 0) throw new PairingDocumentError(`expected "key: value"`, line);
    const key = unquote(text.slice(0, colon).trim());
    const rest = text.slice(colon + 1).trim();
    if (rest === "" || rest === "|" || rest === ">") {
      const next = lines[index];
      if (next !== void 0 && next.indent > indent) {
        const [value, consumed] = parseBlock(lines, index, next.indent);
        out[key] = value;
        index = consumed;
      } else {
        out[key] = null;
      }
    } else {
      out[key] = parseScalar(rest, line);
    }
  }
  return [out, index];
}
function parseSequence(lines, start, indent) {
  const out = [];
  let index = start;
  while (index < lines.length) {
    const current = lines[index];
    if (current.indent !== indent || !isSequenceLine(current.text)) break;
    const rest = current.text.slice(1).trim();
    index += 1;
    if (rest === "") {
      const next2 = lines[index];
      if (next2 !== void 0 && next2.indent > indent) {
        const [value2, consumed2] = parseBlock(lines, index, next2.indent);
        out.push(value2);
        index = consumed2;
      } else {
        out.push(null);
      }
      continue;
    }
    const colon = findColon(rest);
    if (colon < 0) {
      out.push(parseScalar(rest, current.line));
      continue;
    }
    const next = lines[index];
    const childIndent = next !== void 0 && next.indent > indent ? next.indent : indent + 2;
    const [value, consumed] = parseMapping(lines, index, childIndent, { text: rest, line: current.line });
    out.push(value);
    index = consumed;
  }
  return [out, index];
}
function findColon(text) {
  let quote;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== void 0) {
      if (char === quote) quote = void 0;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ":") return index;
  }
  return -1;
}
function parseScalar(text, line) {
  if (text === "null" || text === "~") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "[]") return [];
  if (text === "{}") return {};
  if (/^-?\d+$/u.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d+\.\d+$/u.test(text)) return Number.parseFloat(text);
  if (text.startsWith('"') && text.endsWith('"') || text.startsWith("'") && text.endsWith("'")) {
    return unquote(text);
  }
  if (text.startsWith('"') || text.startsWith("'")) {
    throw new PairingDocumentError("unterminated quoted scalar", line);
  }
  return text;
}
function unquote(text) {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\(["\\nt])/gu, (_match, escape) => {
      if (escape === "n") return "\n";
      if (escape === "t") return "	";
      return escape;
    });
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/gu, "'");
  }
  return text;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/index.ts
var name = "enpoi-peer-bridge";
var inject = ["tools"];
function live(schema) {
  return schema.volatile?.() ?? schema;
}
function plainConfig(config) {
  const out = {};
  for (const [key, field2] of Object.entries(config)) {
    out[key] = typeof field2?.get === "function" ? field2.get() : field2;
  }
  return out;
}
var Config = Schema.object({
  pairingsPath: live(Schema.string()),
  noticesPath: live(Schema.string()),
  device: live(Schema.string()),
  participantName: live(Schema.string()),
  waitMs: live(Schema.number()),
  settleMs: live(Schema.number()),
  maxReconnects: live(Schema.number())
});
var DEFAULT_WAIT_MS = 3e5;
var MAX_MESSAGE_CHARS = 1e5;
var MAX_SURFACE_TASKS = 4;
function apply(ctx, config = {}) {
  const resolved = plainConfig(config);
  try {
    registerTools(ctx, resolved);
  } catch (error) {
    ctx.logger?.error(`enpoi-peer-bridge: tools not registered: ${errorText(error)}`);
  }
}
function registerTools(ctx, config, deps = {}) {
  const pairingsPath = config.pairingsPath ?? defaultPairingsPath();
  const noticesPath = config.noticesPath ?? defaultNoticesPath(dirname2(pairingsPath));
  const waitMs = config.waitMs ?? DEFAULT_WAIT_MS;
  const settleMs = config.settleMs ?? DEFAULT_SETTLE_QUIET_MS;
  const effectiveDeps = {
    ...deps,
    onWarning: deps.onWarning ?? ((hole) => {
      ctx.logger?.warn?.(`enpoi-peer-bridge: peer follow history hole [${String(hole.from)}, ${String(hole.to)}) \u2014 records in that range are missing locally`);
    })
  };
  ctx.tools.register({
    name: "peer_status",
    description: [
      "Handshake with a paired peer device and read its session latch: host identity, capabilities,",
      "exposure, target session id, execution state (latch, active descendants, pending remote asks),",
      "and current model. Use it before peer_ask to confirm the peer and the session are reachable.",
      "The alias names the pairing (the member device in the fleet convention) and is the same string",
      "on both devices \u2014 it is NOT the target host name."
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        alias: { type: "string", description: "Pairing alias from the caller-role entries in the pairings document." }
      },
      required: ["alias"]
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          alias: { type: "string" },
          peer: { type: "string" },
          endpoint: { type: "string" },
          host: {
            type: "object",
            additionalProperties: false,
            properties: {
              device: { type: "string" },
              harnessVersion: { type: "string" },
              protocolVersion: { type: "number" },
              capabilities: { type: "array", items: { type: "string" } }
            },
            required: ["device", "harnessVersion", "protocolVersion", "capabilities"]
          },
          exposure: { type: "string" },
          sessionId: { type: "string" },
          bound: { type: "boolean" },
          latch: { type: "string" },
          latchSource: { type: "string" },
          activeDescendants: { type: "number" },
          descendantsExact: { type: "boolean" },
          model: { type: "string" },
          lastTurnEnd: { type: "string" },
          pendingAsks: { type: "array", items: { type: "string" } },
          note: { type: "string" },
          error: failureSchema()
        },
        required: ["ok"]
      },
      render: (_args, value) => [{ type: "text", text: renderStatus(value) }]
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const request = narrow(args);
      const alias = requireAlias(request.alias);
      const { pairing, document } = resolveEntry(pairingsPath, alias);
      const client = makeClient(pairing, config, document.device, effectiveDeps);
      try {
        const handshake = await client.handshake();
        let bound = pairing.remoteSessionId !== void 0;
        let stateValue;
        try {
          stateValue = await client.state(targetOf(pairing));
          bound = true;
        } catch (error) {
          if (!(error instanceof PeerBridgeError) || error.code !== "peer/not-paired" && error.code !== "peer/not-found") throw error;
          bound = false;
        }
        const state = stateValue?.state;
        return {
          ok: true,
          alias,
          peer: pairing.peer,
          endpoint: pairing.endpoint,
          host: {
            device: handshake.hostDevice,
            harnessVersion: handshake.harnessVersion,
            protocolVersion: handshake.protocolVersion,
            capabilities: [...handshake.capabilities]
          },
          exposure: stateValue?.target.exposure ?? pairing.exposure ?? "unknown",
          sessionId: stateValue?.target.sessionId ?? pairing.remoteSessionId ?? "",
          bound,
          latch: state?.latch ?? "unknown",
          latchSource: state?.source ?? "unknown",
          activeDescendants: state?.activeDescendants ?? 0,
          descendantsExact: state?.descendantsExact ?? false,
          model: state?.model === void 0 ? "" : `${state.model.provider}/${state.model.model}${state.model.chain === void 0 ? "" : ` (${state.model.chain})`}`,
          lastTurnEnd: state?.lastTurnEnd === void 0 ? "" : `turn ${String(state.lastTurnEnd.turn)} ${state.lastTurnEnd.reason}`,
          pendingAsks: (state?.pendingAsks ?? []).map(askSummary),
          note: bound ? "" : "alias is not bound to a session and the pairing pins no remoteSessionId \u2014 peer_ask creates one when the host pairing has a create block"
        };
      } catch (error) {
        return failureFrom(error, pairing.endpoint);
      }
    }
  });
  ctx.tools.register({
    name: "peer_sessions",
    description: [
      "List paired peer sessions: for every caller-role pairing in the local document, the bound remote",
      "session id (the local remoteSessionId pin or the session the host reports), the latch summary, and",
      "last activity. Use it to discover which session an alias currently addresses before peer_ask or",
      "peer_asks. Read-only; an unreachable host appears as that row's error."
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        alias: { type: "string", description: "Limit the listing to one caller-role pairing alias." }
      },
      required: []
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          device: { type: "string" },
          sessions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                alias: { type: "string" },
                peer: { type: "string" },
                endpoint: { type: "string" },
                remoteSessionId: { type: "string" },
                exposure: { type: "string" },
                bound: { type: "boolean" },
                latch: { type: "string" },
                lastActivity: { type: "string" },
                summary: { type: "string" },
                error: failureSchema()
              },
              required: ["alias", "peer"]
            }
          },
          note: { type: "string" },
          error: failureSchema()
        },
        required: ["ok"]
      },
      render: (_args, value) => [{ type: "text", text: renderSessions(value) }]
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const request = narrow(args);
      const filter = typeof request.alias === "string" && request.alias !== "" ? request.alias : void 0;
      let document;
      try {
        document = readPairingDocument(pairingsPath);
      } catch (error) {
        return { ok: false, device: "", sessions: [], error: badRequest(errorText(error)).error };
      }
      const callers = callerPairings(document);
      const dialable = callers.filter((pairing) => filter === void 0 || pairing.alias === filter);
      if (dialable.length === 0) {
        return {
          ok: false,
          device: document.device,
          sessions: [],
          error: badRequest(filter === void 0 ? "no caller-role pairings in the pairing document" : `no caller-role pairing with alias ${JSON.stringify(filter)}; ${describeCallerPairings(callers)}`).error
        };
      }
      const sessions = [];
      for (const pairing of dialable) {
        const base = {
          alias: pairing.alias,
          peer: pairing.peer,
          endpoint: pairing.endpoint,
          remoteSessionId: pairing.remoteSessionId ?? "",
          exposure: pairing.exposure ?? ""
        };
        try {
          const listed = await makeClient(pairing, config, document.device, effectiveDeps).list({});
          const entry = listed.pairings.find((candidate) => candidate.alias === pairing.alias);
          sessions.push({
            ...base,
            remoteSessionId: pairing.remoteSessionId ?? entry?.sessionId ?? "",
            exposure: entry?.exposure ?? base.exposure,
            bound: entry?.bound ?? false,
            ...entry?.latch === void 0 ? {} : { latch: entry.latch },
            ...entry?.lastActivity === void 0 ? {} : { lastActivity: new Date(entry.lastActivity).toISOString() },
            summary: entry === void 0 ? "the host lists no pairing under this alias" : entry.summary
          });
        } catch (error) {
          sessions.push({
            ...base,
            bound: false,
            summary: "",
            error: failureFrom(error, pairing.endpoint).error
          });
        }
      }
      return { ok: true, device: document.device, sessions };
    }
  });
  ctx.tools.register({
    name: "peer_ask",
    description: [
      "Send a message to a paired peer session as an attributed peer turn, then follow the remote",
      "session until the turn reaches a terminal state and return the remote answer (or the structured",
      "failure when the turn failed). If the followed turn enters waiting_approval, the call returns",
      'EARLY with status "waiting_approval" and the pending ask(s) (askId, kind, toolName, reason)',
      "instead of blocking: decide each with peer_asks/peer_answer, then call peer_ask again with",
      "resume set to the returned requestId to follow the same turn to completion. Remote asks that",
      "appear while following are surfaced locally for the operator to answer. The remote runs with",
      "its OWN tools, workspace, and approvals.",
      "The alias names the pairing (the member device in the fleet convention) and is the same string",
      "on both devices \u2014 it is NOT the target host name."
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        alias: { type: "string", description: "Pairing alias of the peer session to prompt." },
        message: { type: "string", description: "The message to send (plain text); omit when resuming." },
        waitMs: { type: "number", description: `How long to follow, in milliseconds (default ${String(waitMs)}).` },
        resume: {
          type: "string",
          description: [
            "A requestId from a prior peer_ask result (waiting_approval or pending): continues",
            "following that same remote turn to its terminal state without sending the message again."
          ].join(" ")
        }
      },
      required: ["alias"]
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          pending: { type: "boolean" },
          alias: { type: "string" },
          sessionId: { type: "string" },
          created: { type: "boolean" },
          requestId: { type: "string" },
          admitted: { type: "boolean" },
          resumed: { type: "boolean" },
          status: { type: "string" },
          settled: { type: "boolean" },
          superseded: { type: "boolean" },
          turn: { type: "number" },
          terminal: { type: "string" },
          error: failureSchema(),
          remoteError: {
            type: "object",
            additionalProperties: false,
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              provider: { type: "string" },
              model: { type: "string" }
            },
            required: ["code", "message"]
          },
          answer: { type: "string" },
          asks: { type: "array", items: { type: "string" } },
          pendingAsks: { type: "array", items: askItemSchema() },
          latch: { type: "string" },
          cursor: { type: "number" },
          note: { type: "string" }
        },
        required: ["ok"]
      },
      render: (_args, value) => [{ type: "text", text: renderAsk(value) }]
    },
    async execute(args, exec) {
      const request = narrow(args);
      const alias = requireAlias(request.alias);
      const message = typeof request.message === "string" ? request.message : "";
      const resumeRaw = request.resume;
      if (resumeRaw !== void 0 && (typeof resumeRaw !== "string" || resumeRaw === "")) {
        return { ok: false, error: { code: "gateway/bad-request", message: "resume must be the requestId string from a prior peer_ask result" } };
      }
      const resume = typeof resumeRaw === "string" ? resumeRaw : void 0;
      if (resume !== void 0 && message.trim() !== "") {
        return { ok: false, error: { code: "gateway/bad-request", message: "resume continues a followed turn; drop message (the first peer_ask already sent it)" } };
      }
      if (resume === void 0 && message.trim() === "") return { ok: false, error: { code: "gateway/bad-request", message: "peer_ask needs a non-empty message" } };
      if (message.length > MAX_MESSAGE_CHARS) {
        return { ok: false, error: { code: "gateway/bad-request", message: `peer_ask message exceeds ${String(MAX_MESSAGE_CHARS)} characters` } };
      }
      const requestedWait = typeof request.waitMs === "number" && Number.isFinite(request.waitMs) && request.waitMs > 0 ? Math.trunc(request.waitMs) : waitMs;
      return runAsk(ctx, {
        pairingsPath,
        noticesPath,
        waitMs: requestedWait,
        settleMs,
        config,
        signal: exec.signal,
        agent: exec.agent,
        alias,
        message,
        ...resume === void 0 ? {} : { resume },
        allowCreate: true,
        deps: effectiveDeps
      });
    }
  });
  ctx.tools.register({
    name: "peer_asks",
    description: "List the pending asks (approvals and questions) on a paired peer session so the local operator can decide them with peer_answer.",
    parameters: {
      type: "object",
      properties: {
        alias: { type: "string", description: "Pairing alias of the peer session." }
      },
      required: ["alias"]
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          alias: { type: "string" },
          sessionId: { type: "string" },
          latch: { type: "string" },
          asks: {
            type: "array",
            items: askItemSchema()
          },
          error: failureSchema()
        },
        required: ["ok"]
      },
      render: (_args, value) => [{ type: "text", text: renderAsks(value) }]
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const request = narrow(args);
      const alias = requireAlias(request.alias);
      const { pairing } = resolveEntry(pairingsPath, alias);
      const client = makeClient(pairing, config, void 0, effectiveDeps);
      try {
        const value = await client.state(targetOf(pairing));
        return {
          ok: true,
          alias,
          sessionId: value.target.sessionId,
          latch: value.state.latch,
          asks: value.state.pendingAsks.map(askPayload)
        };
      } catch (error) {
        return failureFrom(error, pairing.endpoint);
      }
    }
  });
  ctx.tools.register({
    name: "peer_answer",
    description: [
      "Answer one pending ask on a paired peer session. Approvals take outcome allowed-once or rejected;",
      "questions take answers[] naming each question id and the selected option labels (see peer_asks for",
      "the ids and options). First answer wins \u2014 a peer/conflict means another participant already settled",
      "it and the answer must not be retried blindly. A malformed selection is rejected here with the",
      "reason and never reaches the host."
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        alias: { type: "string", description: "Pairing alias of the peer session." },
        askId: { type: "string", description: "Remote ask id from peer_asks or a peer_ask result." },
        outcome: { type: "string", enum: ["allowed-once", "rejected"], description: "Approval outcome (allowed-always is not grantable from a peer)." },
        answers: {
          type: "array",
          description: "Question-ask answer: one entry per remote question id with the selected option labels.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", description: "Question id from peer_asks." },
              selected: { type: "array", items: { type: "string" }, description: "Selected option labels." },
              custom: { type: "string", description: "Optional free-text answer." }
            },
            required: ["id", "selected"]
          }
        }
      },
      required: ["alias", "askId"]
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          alias: { type: "string" },
          askId: { type: "string" },
          settled: { type: "boolean" },
          confirmation: { type: "string" },
          note: { type: "string" },
          error: failureSchema()
        },
        required: ["ok"]
      },
      render: (_args, value) => [{ type: "text", text: renderAnswer(value) }]
    },
    async execute(args) {
      const request = narrow(args);
      const alias = requireAlias(request.alias);
      const askId = typeof request.askId === "string" && request.askId !== "" ? request.askId : void 0;
      if (askId === void 0) return { ok: false, error: { code: "gateway/bad-request", message: "peer_answer needs an askId" } };
      const outcome = request.outcome;
      const rawAnswers = Array.isArray(request.answers) ? request.answers : void 0;
      if (outcome !== void 0 && rawAnswers !== void 0) {
        return badRequest("peer_answer takes either outcome (approval) or answers (question), not both");
      }
      if (outcome === void 0 && rawAnswers === void 0) {
        return badRequest("peer_answer needs outcome for an approval ask or answers[] for a question ask");
      }
      if (outcome !== void 0 && outcome !== "allowed-once" && outcome !== "rejected") {
        return badRequest("peer_answer outcome must be allowed-once or rejected (allowed-always is not grantable from a peer)");
      }
      const { pairing, document } = resolveEntry(pairingsPath, alias);
      const client = makeClient(pairing, config, document.device, effectiveDeps);
      let answer;
      if (outcome !== void 0) {
        answer = { kind: "approval", outcome };
      } else {
        const parsed = parseQuestionSelections(rawAnswers ?? []);
        if (!parsed.ok) return badRequest(parsed.message);
        let pending;
        try {
          const value = await client.state(targetOf(pairing));
          pending = value.state.pendingAsks.find((candidate) => candidate.askId === askId);
        } catch (error) {
          return failureFrom(error, pairing.endpoint);
        }
        if (pending === void 0) {
          return badRequest(`no pending ask ${askId} on ${alias} \u2014 it may have settled or the session changed; re-run peer_asks`);
        }
        if (pending.kind !== "question") {
          return badRequest(`ask ${askId} is an approval ask; answer it with outcome allowed-once or rejected`);
        }
        const normalized = normalizeQuestionSelections(pending.questions ?? [], parsed.selections);
        if (!normalized.ok) return badRequest(normalized.message);
        answer = { kind: "question", answer: normalized.answer };
      }
      const target = targetOf(pairing);
      try {
        await client.answer({
          target,
          participant: participantOf(config, document),
          askId,
          answer
        });
        return {
          ok: true,
          alias,
          askId,
          settled: true,
          confirmation: "confirmed",
          note: answer.kind === "question" ? "question settled; the first answer won" : "ask settled; the first answer won"
        };
      } catch (error) {
        const conflict = error instanceof PeerBridgeError && error.code === "peer/conflict";
        if (!conflict && error instanceof PeerBridgeError && error.code === "peer/target-unreachable") {
          const reread = await client.state(target).catch(() => void 0);
          if (reread !== void 0 && !reread.state.pendingAsks.some((candidate) => candidate.askId === askId)) {
            return {
              ok: true,
              alias,
              askId,
              settled: false,
              confirmation: "lost",
              note: "the answer transport failed with no confirmation, but the remote ask is no longer pending \u2014 it was settled remotely (by this answer or another participant); re-run peer_asks before resending"
            };
          }
        }
        return {
          ok: false,
          alias,
          askId,
          settled: false,
          note: conflict ? "another participant already answered this ask (peer/conflict) \u2014 report it; do not retry blind" : errorText(error),
          error: failureFrom(error, pairing.endpoint).error
        };
      }
    }
  });
  ctx.tools.register({
    name: "peer_cancel",
    description: "Cancel the active turn on a paired peer session, attributed to this caller. A human on the remote preempts peers; this asks the remote to stop.",
    parameters: {
      type: "object",
      properties: {
        alias: { type: "string", description: "Pairing alias of the peer session." }
      },
      required: ["alias"]
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          alias: { type: "string" },
          cancelled: { type: "boolean" },
          confirmation: { type: "string" },
          note: { type: "string" },
          error: failureSchema()
        },
        required: ["ok"]
      },
      render: (_args, value) => {
        const record = narrow(value);
        return [{
          type: "text",
          text: record.ok === true ? `${record.cancelled === true ? "Cancelled" : "Nothing to cancel on"} ${String(record.alias)} \u2014 ${String(record.note ?? "")}` : `peer_cancel failed: ${String(narrow(record.error).message ?? "")}`
        }];
      }
    },
    async execute(args) {
      const request = narrow(args);
      const alias = requireAlias(request.alias);
      const { pairing, document } = resolveEntry(pairingsPath, alias);
      const client = makeClient(pairing, config, document.device, effectiveDeps);
      try {
        const value = await client.cancel({ target: targetOf(pairing), participant: participantOf(config, document) });
        return {
          ok: true,
          alias,
          cancelled: value.cancelled,
          confirmation: "confirmed",
          note: value.cancelled ? "remote turn cancelled" : "remote session had no active turn"
        };
      } catch (error) {
        if (error instanceof PeerBridgeError && error.code === "peer/target-unreachable") {
          const reread = await client.state(targetOf(pairing)).catch(() => void 0);
          if (reread !== void 0 && reread.state.latch !== "running") {
            return {
              ok: true,
              alias,
              cancelled: false,
              confirmation: "lost",
              note: "the cancel confirmation was lost (transport failure); the remote reports no active turn \u2014 it may have completed or been cancelled"
            };
          }
        }
        return failureFrom(error, pairing.endpoint);
      }
    }
  });
}
async function runAsk(ctx, options) {
  const { pairing, document } = resolveEntry(options.pairingsPath, options.alias);
  const client = makeClient(pairing, options.config, document.device, options.deps);
  const participant = participantOf(options.config, document);
  const resumed = options.resume !== void 0 && options.resume !== "";
  let created = false;
  try {
    await client.handshake();
  } catch (error) {
    return failureFrom(error, pairing.endpoint);
  }
  const requestedTarget = targetOf(pairing);
  let baseline;
  try {
    baseline = await client.state(requestedTarget);
  } catch (error) {
    const code = error instanceof PeerBridgeError ? error.code : "";
    if (resumed || !options.allowCreate || requestedTarget.kind !== "alias" || code !== "peer/not-paired" && code !== "peer/not-found") {
      return failureFrom(error, pairing.endpoint);
    }
    try {
      const defaults = pairing.create ?? {};
      await client.create({
        alias: pairing.alias,
        participant,
        ...typeof defaults.cwd === "string" ? { cwd: defaults.cwd } : {},
        ...typeof defaults.agentPreset === "string" ? { agentPreset: defaults.agentPreset } : {},
        // The host pins this route on the created Session only; the parser
        // already guarantees provider+model travel together.
        ...pairing.createRouting ?? {}
      });
      created = true;
      baseline = await client.state(requestedTarget);
    } catch (createError) {
      return failureFrom(createError, pairing.endpoint);
    }
  }
  const baselineTurn = baseline.state.lastTurnEnd?.turn ?? 0;
  const requestId = options.resume ?? `peer-bridge-${randomUUID()}`;
  if (!resumed) {
    try {
      await client.prompt({
        target: requestedTarget,
        participant,
        requestId,
        content: [{ type: "text", text: options.message }],
        hopCount: 0
      });
    } catch (error) {
      return failureFrom(error, pairing.endpoint);
    }
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.waitMs);
  const relayAbort = () => {
    controller.abort();
  };
  options.signal.addEventListener("abort", relayAbort, { once: true });
  const asks = /* @__PURE__ */ new Map();
  let latch = baseline.state.latch;
  let cursor = baseline.cursor;
  const admitted = !resumed;
  let terminal;
  let detached = false;
  let approvalPause = false;
  let activeDescendants = baseline.state.activeDescendants;
  let descendantsExact = baseline.state.descendantsExact;
  let pendingNow = baseline.state.pendingAsks;
  let pendingAskCount = pendingNow.length;
  const answerParts = [];
  let answerTurn;
  const seenSeqs = /* @__PURE__ */ new Set();
  let admittedTurn = resumed ? baselineTurn + 1 : void 0;
  let observedTurn;
  let admissionSeen = false;
  let abandoned = false;
  let quietExpired = false;
  let quietTimer;
  const clearQuiet = () => {
    if (quietTimer !== void 0) {
      clearTimeout(quietTimer);
      quietTimer = void 0;
    }
  };
  const armQuiet = () => {
    clearQuiet();
    quietTimer = setTimeout(() => {
      quietExpired = true;
      controller.abort();
    }, options.settleMs);
  };
  const settledNow = () => isPeerSessionSettled({
    terminal,
    latch,
    activeDescendants,
    descendantsExact,
    pendingAskCount
  });
  const inFlight = /* @__PURE__ */ new Set();
  const withdrawMissing = (pending) => {
    const present = new Set(pending.map((ask) => ask.askId));
    for (const record of asks.values()) {
      if (present.has(record.askId) || record.withdrawn === true) continue;
      if (record.decision !== void 0 || record.relay !== void 0) continue;
      record.withdrawn = true;
      record.note = "settled elsewhere first (another device answered) \u2014 local card dismissed";
      record.card.abort(new Error("remote ask settled before the local answer"));
    }
  };
  const surface = (pending) => {
    const task = surfacePending(
      ctx,
      client,
      options.noticesPath,
      pairing,
      participant,
      requestedTarget,
      pending,
      asks,
      AbortSignal.any([options.signal, controller.signal]),
      options.agent
    ).catch((error) => {
      ctx.logger?.warn?.(`enpoi-peer-bridge: surfacing remote asks failed: ${errorText(error)}`);
    }).finally(() => {
      inFlight.delete(task);
    });
    inFlight.add(task);
  };
  const surfaceFrame = async (pending) => {
    withdrawMissing(pending);
    while (inFlight.size >= MAX_SURFACE_TASKS) await Promise.race(inFlight);
    surface(pending);
  };
  const absorb = (record) => {
    if (recordRpcId(record) === requestId) {
      if (!admissionSeen) {
        admissionSeen = true;
        const turn2 = recordTurn(record) ?? observedTurn;
        if (turn2 !== void 0) admittedTurn = turn2;
      }
    }
    if (typeof record.seq === "number") {
      if (seenSeqs.has(record.seq)) return;
      seenSeqs.add(record.seq);
    }
    const turn = recordTurn(record);
    if (record.type === "user/message" && admittedTurn !== void 0 && recordRpcId(record) !== requestId) {
      const promptTurn = turn ?? observedTurn;
      if (promptTurn !== void 0 && promptTurn !== admittedTurn && recordSourceKind(record) === "user") abandoned = true;
    }
    if (record.type === "turn/start" && turn !== void 0) {
      observedTurn = turn;
      if (admissionSeen && admittedTurn === void 0) admittedTurn = turn;
      return;
    }
    if (admittedTurn === void 0 && admissionSeen && turn !== void 0) admittedTurn = turn;
    const floor = admittedTurn ?? baselineTurn + 1;
    const attributed = admittedTurn !== void 0 && turn !== void 0 && turn >= admittedTurn && (!abandoned || turn <= admittedTurn);
    if (!attributed) return;
    if (record.type === "assistant/message" && turn !== void 0 && turn >= floor) {
      const text = recordAssistantText(record);
      if (text !== "") {
        if (answerTurn === void 0 || turn > answerTurn) {
          answerTurn = turn;
          answerParts.length = 0;
        }
        if (turn === answerTurn) answerParts.push(text);
      }
      return;
    }
    const end = recordTerminal(record);
    if (end !== void 0 && end.turn >= floor) {
      if (answerTurn !== void 0 && answerTurn !== end.turn) {
        answerTurn = void 0;
        answerParts.length = 0;
      }
      terminal = end;
    }
  };
  try {
    for await (const frame of client.follow({ target: requestedTarget }, controller.signal)) {
      if (frame.type === "snapshot") {
        cursor = frame.cursor;
        latch = frame.state.latch;
        activeDescendants = frame.state.activeDescendants;
        descendantsExact = frame.state.descendantsExact;
        pendingNow = frame.state.pendingAsks;
        pendingAskCount = pendingNow.length;
        for (const record of frame.records) absorb(record);
        await surfaceFrame(pendingNow);
      } else if (frame.type === "state") {
        cursor = frame.cursor;
        latch = frame.state.latch;
        activeDescendants = frame.state.activeDescendants;
        descendantsExact = frame.state.descendantsExact;
        pendingNow = frame.state.pendingAsks;
        pendingAskCount = pendingNow.length;
        await surfaceFrame(pendingNow);
      } else if (frame.type === "event") {
        cursor = Math.max(cursor, frame.record.seq);
        absorb(frame.record);
      } else if (frame.type === "end" && frame.reason === "target-detached") {
        detached = true;
        break;
      }
      if (latch === "waiting_approval" && pendingNow.length > 0) {
        approvalPause = true;
        break;
      }
      if (abandoned && terminal !== void 0) break;
      if (terminal !== void 0) {
        if (settledNow()) armQuiet();
        else clearQuiet();
      }
    }
  } catch (error) {
    if (!timedOut && !controller.signal.aborted) return failureFrom(error, pairing.endpoint);
  } finally {
    clearTimeout(timer);
    clearQuiet();
    options.signal.removeEventListener("abort", relayAbort);
    controller.abort();
    await Promise.allSettled([...inFlight]);
  }
  if (quietExpired) {
    try {
      const confirmed = await client.state(requestedTarget);
      latch = confirmed.state.latch;
      activeDescendants = confirmed.state.activeDescendants;
      descendantsExact = confirmed.state.descendantsExact;
      pendingAskCount = confirmed.state.pendingAsks.length;
      cursor = Math.max(cursor, confirmed.cursor);
    } catch {
    }
  }
  if (detached) {
    return {
      ok: false,
      pending: true,
      alias: pairing.alias,
      sessionId: baseline.target.sessionId,
      created,
      requestId,
      admitted,
      ...resumed ? { resumed: true } : {},
      asks: askLines(asks),
      latch,
      cursor,
      note: "the remote pairing/session binding disappeared (target-detached)"
    };
  }
  if (approvalPause) {
    const ids = pendingNow.map((ask) => ask.askId);
    return {
      ok: false,
      pending: true,
      status: "waiting_approval",
      settled: false,
      alias: pairing.alias,
      sessionId: baseline.target.sessionId,
      created,
      requestId,
      admitted,
      ...resumed ? { resumed: true } : {},
      asks: askLines(asks),
      pendingAsks: pendingNow.map(askPayload),
      latch,
      cursor,
      note: [
        `the remote turn is waiting_approval on ${String(ids.length)} ask(s): ${ids.join(", ")}`,
        `decide each with peer_asks/peer_answer, then call peer_ask again with resume: ${JSON.stringify(requestId)}`,
        "to follow the same turn to completion (no message is re-sent)"
      ].join(" \u2014 ")
    };
  }
  const answer = answerParts.join("\n").trim();
  if (terminal === void 0) {
    return {
      ok: false,
      pending: true,
      alias: pairing.alias,
      sessionId: baseline.target.sessionId,
      created,
      requestId,
      admitted,
      ...resumed ? { resumed: true } : {},
      answer,
      asks: askLines(asks),
      latch,
      cursor,
      note: `no terminal within ${String(options.waitMs)}ms \u2014 the remote turn is still live (follow it again with peer_ask resume: ${JSON.stringify(requestId)}, or ds peer follow)`
    };
  }
  if (abandoned) {
    return {
      ok: terminal.reason === "completed",
      settled: true,
      superseded: true,
      alias: pairing.alias,
      sessionId: baseline.target.sessionId,
      created,
      requestId,
      admitted,
      ...resumed ? { resumed: true } : {},
      turn: terminal.turn,
      terminal: terminal.reason,
      ...terminal.error === void 0 ? {} : {
        remoteError: {
          code: terminal.error.code ?? "unknown",
          message: terminal.error.message ?? "",
          provider: terminal.error.provider ?? "",
          model: terminal.error.model ?? ""
        }
      },
      answer,
      asks: askLines(asks),
      cursor,
      note: `a different operator's prompt opened a later turn after turn ${String(terminal.turn)} ended; returning this turn's own result \u2014 follow the alias again to collect the remainder`
    };
  }
  if (!settledNow()) {
    return {
      ok: false,
      pending: true,
      settled: false,
      alias: pairing.alias,
      sessionId: baseline.target.sessionId,
      created,
      requestId,
      admitted,
      ...resumed ? { resumed: true } : {},
      turn: terminal.turn,
      terminal: terminal.reason,
      ...terminal.error === void 0 ? {} : {
        remoteError: {
          code: terminal.error.code ?? "unknown",
          message: terminal.error.message ?? "",
          provider: terminal.error.provider ?? "",
          model: terminal.error.model ?? ""
        }
      },
      answer,
      asks: askLines(asks),
      latch,
      cursor,
      note: `remote turn ${String(terminal.turn)} ended: ${terminal.reason} but the session was not settled when following stopped (${unsettledSummary(latch, activeDescendants, pendingAskCount)}) \u2014 follow again to collect the remainder`
    };
  }
  if (terminal.reason !== "completed") {
    return {
      ok: false,
      settled: true,
      alias: pairing.alias,
      sessionId: baseline.target.sessionId,
      created,
      requestId,
      admitted,
      ...resumed ? { resumed: true } : {},
      turn: terminal.turn,
      terminal: terminal.reason,
      ...terminal.error === void 0 ? {} : {
        remoteError: {
          code: terminal.error.code ?? "unknown",
          message: terminal.error.message ?? "",
          provider: terminal.error.provider ?? "",
          model: terminal.error.model ?? ""
        }
      },
      answer,
      asks: askLines(asks),
      cursor,
      note: `remote turn ${String(terminal.turn)} ended: ${terminal.reason}`
    };
  }
  return {
    ok: true,
    settled: true,
    alias: pairing.alias,
    sessionId: baseline.target.sessionId,
    created,
    requestId,
    admitted,
    ...resumed ? { resumed: true } : {},
    turn: terminal.turn,
    terminal: "completed",
    answer,
    asks: askLines(asks),
    cursor,
    note: asks.size === 0 ? "" : "remote asks were raised locally; see asks[] for the decisions relayed"
  };
}
function unsettledSummary(latch, activeDescendants, pendingAskCount) {
  if (activeDescendants > 0) return `${String(activeDescendants)} live descendant(s)`;
  if (pendingAskCount > 0) return `${String(pendingAskCount)} pending ask(s)`;
  if (latch === "running") return "a turn is still running";
  if (latch === "waiting_subagents") return "descendants are still settling";
  if (latch === "waiting_approval") return "an ask is pending";
  return "the quiet window had not elapsed";
}
async function surfacePending(ctx, client, noticesPath, pairing, participant, target, pending, asks, signal, agent) {
  const sessionLabel = target.kind === "session" ? target.sessionId : pairing.remoteSessionId ?? pairing.alias;
  for (const ask of pending) {
    if (asks.has(ask.askId)) continue;
    const record = {
      askId: ask.askId,
      kind: ask.kind,
      ...ask.kind === "approval" && ask.toolName !== void 0 ? { toolName: ask.toolName } : {},
      ...ask.kind === "approval" && ask.reason !== void 0 ? { reason: ask.reason } : {},
      surfaced: "notice",
      summary: askSummary(ask),
      card: new AbortController()
    };
    asks.set(ask.askId, record);
    const askSignal = AbortSignal.any([signal, record.card.signal]);
    if (ask.kind === "question") {
      await surfaceQuestion(ctx, client, noticesPath, pairing, participant, target, ask, record, askSignal, agent);
      continue;
    }
    const approval = ctx.get("approval");
    if (approval === void 0 || agent === void 0) {
      record.decision = "unsurfaced";
      record.note = "local approval service unavailable; ask recorded as a durable notice and answerable via peer_answer";
      recordAskNotice(noticesPath, pairing.alias, sessionLabel, ask, record.note);
      continue;
    }
    let decision;
    try {
      const outcome = await approval.request({
        agent,
        toolName: ask.toolName ?? "peer.ask",
        reason: askLabel(pairing.alias, sessionLabel, ask),
        signal: askSignal
      });
      if (record.withdrawn === true) {
        record.decision = "cancelled";
        continue;
      }
      decision = outcome === "allowed-always" || outcome === "allowed-always-broad" ? "allowed-once" : outcome;
      record.surfaced = "approval";
    } catch {
      if (record.withdrawn === true) {
        record.decision = "cancelled";
        continue;
      }
      decision = "unsurfaced";
    }
    const mapped = localDecisionToPeerAnswer(decision);
    record.decision = decision;
    if (mapped.outcome === void 0) {
      record.note = mapped.note;
      recordAskNotice(noticesPath, pairing.alias, sessionLabel, ask, mapped.note);
      continue;
    }
    try {
      await client.answer({
        target,
        participant,
        askId: ask.askId,
        answer: { kind: "approval", outcome: mapped.outcome }
      });
      record.relay = "settled";
      record.note = mapped.note;
    } catch (error) {
      const code = error instanceof PeerBridgeError ? error.code : "unknown";
      record.relay = code === "peer/conflict" ? "conflict" : code === "peer/not-found" ? "not-found" : "failed";
      record.note = code === "peer/conflict" ? "another participant answered first (peer/conflict) \u2014 not retried" : `relay failed: ${errorText(error)}`;
    }
  }
}
async function surfaceQuestion(ctx, client, noticesPath, pairing, participant, target, ask, record, signal, agent) {
  const sessionLabel = target.kind === "session" ? target.sessionId : pairing.remoteSessionId ?? pairing.alias;
  const questions = ask.kind === "question" ? ask.questions ?? [] : [];
  const userQuestions = ctx.get("userQuestions");
  if (userQuestions === void 0 || questions.length === 0) {
    record.decision = "unsurfaced";
    record.note = "local user-questions service unavailable; question ask recorded with its options and answerable via peer_answer";
    recordAskNotice(noticesPath, pairing.alias, sessionLabel, ask, record.note);
    return;
  }
  let answer;
  try {
    answer = await userQuestions.ask({
      questions: questions.map((question) => ({
        id: question.id,
        question: question.question,
        ...question.detail === void 0 ? {} : { detail: question.detail },
        ...question.header === void 0 ? {} : { header: question.header },
        ...question.options === void 0 ? {} : { options: question.options.map((option) => ({ label: option.label, ...option.description === void 0 ? {} : { description: option.description } })) },
        ...question.multiSelect === void 0 ? {} : { multiSelect: question.multiSelect }
      })),
      ...agent === void 0 ? {} : { agent },
      signal
    });
    if (record.withdrawn === true) {
      record.decision = "cancelled";
      return;
    }
    record.surfaced = "question";
    record.selected = answer.answers.flatMap((item) => item.selected);
  } catch (error) {
    if (record.withdrawn === true) {
      record.decision = "cancelled";
      return;
    }
    record.decision = "unsurfaced";
    record.note = `local question answerer declined (${errorText(error)}); question ask recorded with its options and answerable via peer_answer`;
    recordAskNotice(noticesPath, pairing.alias, sessionLabel, ask, record.note);
    return;
  }
  try {
    await client.answer({ target, participant, askId: ask.askId, answer: { kind: "question", answer } });
    record.relay = "settled";
    record.note = "local question answered \u2192 relayed";
  } catch (error) {
    const code = error instanceof PeerBridgeError ? error.code : "unknown";
    record.relay = code === "peer/conflict" ? "conflict" : code === "peer/not-found" ? "not-found" : "failed";
    record.note = code === "peer/conflict" ? "another participant answered first (peer/conflict) \u2014 not retried" : `relay failed: ${errorText(error)}`;
  }
}
function recordAskNotice(path, alias, sessionId, ask, note) {
  const notice = {
    at: Date.now(),
    alias,
    sessionId,
    askId: ask.askId,
    kind: ask.kind,
    ...ask.kind === "approval" && ask.toolName !== void 0 ? { toolName: ask.toolName } : {},
    ...ask.kind === "approval" && ask.reason !== void 0 ? { reason: ask.reason } : {},
    ...ask.kind === "question" ? { questions: ask.questions ?? [] } : {},
    note
  };
  appendAskNotice(path, notice);
}
function resolveEntry(pairingsPath, alias) {
  return loadCallerPairing(pairingsPath, alias);
}
function targetOf(pairing) {
  return pairing.remoteSessionId === void 0 ? { kind: "alias", alias: pairing.alias } : { kind: "session", sessionId: pairing.remoteSessionId };
}
function participantOf(config, document) {
  const device = config.device ?? document.device;
  return { kind: "peer", name: config.participantName ?? device, device };
}
function makeClient(pairing, config, device, deps = {}) {
  const headers = pairing.token === void 0 ? {} : { authorization: `Bearer ${pairing.token}` };
  return new PeerClient({
    endpoint: pairing.endpoint,
    device: config.device ?? device ?? pairing.peer,
    headers,
    ...config.maxReconnects === void 0 ? {} : { maxReconnects: config.maxReconnects },
    ...deps.fetch === void 0 ? {} : { fetch: deps.fetch },
    ...deps.webSocket === void 0 ? {} : { webSocket: deps.webSocket },
    ...deps.onWarning === void 0 ? {} : { onWarning: deps.onWarning }
  });
}
function narrow(args) {
  return typeof args === "object" && args !== null ? args : {};
}
function badRequest(message) {
  return { ok: false, error: { code: "gateway/bad-request", message } };
}
function parseQuestionSelections(raw) {
  if (raw.length === 0) return { ok: false, message: "answers[] is empty; name at least one question id with its selected labels" };
  const selections = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return { ok: false, message: "every answers[] entry must be an object {id, selected[]}" };
    const item = entry;
    if (typeof item.id !== "string" || item.id === "") return { ok: false, message: "every answers[] entry needs a string question id" };
    if (!Array.isArray(item.selected) || !item.selected.every((label) => typeof label === "string")) {
      return { ok: false, message: `answers[] entry ${JSON.stringify(item.id)} needs selected[] as an array of option labels` };
    }
    if (item.custom !== void 0 && typeof item.custom !== "string") {
      return { ok: false, message: `answers[] entry ${JSON.stringify(item.id)} has a non-string custom value` };
    }
    selections.push({
      id: item.id,
      selected: [...item.selected],
      ...typeof item.custom === "string" ? { custom: item.custom } : {}
    });
  }
  return { ok: true, selections };
}
function requireAlias(value) {
  if (typeof value !== "string" || value === "") {
    throw new PeerBridgeError("gateway/bad-request", "alias must be a non-empty string", "");
  }
  return value;
}
function failureFrom(error, endpoint) {
  if (error instanceof PeerBridgeError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.code === "peer/target-unreachable" ? `REMOTE TARGET UNREACHABLE: ${error.endpoint}` : error.message,
        endpoint: error.endpoint,
        ...error.code === "peer/target-unreachable" ? { hint: "the peer device is offline or the endpoint is wrong; the caller owns backoff and no turn was queued remotely" } : {}
      }
    };
  }
  const code = error?.code;
  return {
    ok: false,
    error: {
      code: typeof code === "string" ? code : "gateway/internal",
      message: errorText(error),
      endpoint
    }
  };
}
function errorText(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
function failureSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      code: { type: "string" },
      message: { type: "string" },
      endpoint: { type: "string" },
      hint: { type: "string" }
    },
    required: ["code", "message"]
  };
}
function askItemSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      askId: { type: "string" },
      kind: { type: "string" },
      toolName: { type: "string" },
      reason: { type: "string" },
      questions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            question: { type: "string" },
            multiSelect: { type: "boolean" },
            options: { type: "array", items: { type: "string" } }
          },
          required: ["id", "question", "options"]
        }
      },
      since: { type: "number" }
    },
    required: ["askId", "kind", "since"]
  };
}
function askPayload(ask) {
  return {
    askId: ask.askId,
    kind: ask.kind,
    toolName: ask.kind === "approval" ? ask.toolName ?? "" : "",
    reason: ask.kind === "approval" ? ask.reason ?? "" : "",
    questions: ask.kind === "question" ? (ask.questions ?? []).map((question) => ({
      id: question.id,
      question: question.question,
      multiSelect: question.multiSelect === true,
      options: (question.options ?? []).map((option) => option.label)
    })) : [],
    since: ask.since
  };
}
function askLines(asks) {
  return [...asks.values()].map((record) => {
    const parts = [record.summary];
    if (record.decision !== void 0) parts.push(`decision=${record.decision}`);
    if (record.selected !== void 0 && record.selected.length > 0) parts.push(`selected=${record.selected.join(",")}`);
    if (record.relay !== void 0) parts.push(`relay=${record.relay}`);
    if (record.note !== void 0 && record.note !== "") parts.push(record.note);
    return parts.join(" \u2014 ");
  });
}
function renderStatus(value) {
  const record = narrow(value);
  if (record.ok !== true) {
    const error = narrow(record.error);
    return `peer_status failed [${String(error.code ?? "unknown")}]: ${String(error.message ?? "")}${error.endpoint === void 0 ? "" : ` (${String(error.endpoint)})`}`;
  }
  const host = narrow(record.host);
  const pendingAsks = Array.isArray(record.pendingAsks) ? record.pendingAsks : [];
  return [
    `peer ${String(record.alias)} \u2192 ${String(host.device ?? "")} @ ${String(record.endpoint)}`,
    `session ${String(record.sessionId)} (${String(record.exposure)}) bound=${String(record.bound)}`,
    `latch ${String(record.latch)} (${String(record.latchSource)}), descendants ${String(record.activeDescendants)}, model ${String(record.model)}`,
    pendingAsks.length === 0 ? "no pending asks" : `pending: ${pendingAsks.join("; ")}`
  ].join("\n");
}
function renderSessions(value) {
  const record = narrow(value);
  const sessions = Array.isArray(record.sessions) ? record.sessions : [];
  if (record.ok !== true && sessions.length === 0) {
    const error = narrow(record.error);
    return `peer_sessions failed [${String(error.code ?? "unknown")}]: ${String(error.message ?? "")}`;
  }
  if (sessions.length === 0) return `no caller-role pairings on ${String(record.device ?? "")}`;
  return [
    `device ${String(record.device ?? "")} \xB7 ${String(sessions.length)} pairing(s)`,
    ...sessions.map((session) => {
      const error = session.error === void 0 ? void 0 : narrow(session.error);
      const state = error !== void 0 ? `unreachable [${String(error.code ?? "unknown")}] ${String(error.message ?? "")}` : `${session.remoteSessionId === "" ? "not bound" : `session ${String(session.remoteSessionId)}`} (${String(session.exposure ?? "")}) bound=${String(session.bound === true)} latch=${String(session.latch ?? "unknown")}${session.summary === "" ? "" : ` \u2014 ${String(session.summary)}`}`;
      return `\u2022 ${String(session.alias)} \u2192 ${String(session.peer)} @ ${String(session.endpoint)} \xB7 ${state}`;
    })
  ].join("\n");
}
function renderAsk(value) {
  const record = narrow(value);
  if (record.error !== void 0 && record.ok !== true && record.pending !== true) {
    const error = narrow(record.error);
    if (error.code === "peer/target-unreachable") {
      const message = String(error.message ?? "");
      return message.startsWith("REMOTE TARGET UNREACHABLE") ? message : `REMOTE TARGET UNREACHABLE: ${message}`;
    }
    return `peer_ask failed [${String(error.code ?? "unknown")}]: ${String(error.message ?? "")}`;
  }
  const lines = [];
  if (record.status === "waiting_approval") {
    const pendingAsks = Array.isArray(record.pendingAsks) ? record.pendingAsks : [];
    lines.push(`REMOTE TURN WAITING FOR APPROVAL on ${String(record.alias)} (session ${String(record.sessionId)}).`);
    lines.push(renderAsks({ ok: true, alias: record.alias, latch: record.latch, asks: pendingAsks }));
    lines.push(`decide with peer_asks/peer_answer, then call peer_ask again with resume: ${JSON.stringify(String(record.requestId))} to follow the same turn to completion.`);
    if (Array.isArray(record.asks) && record.asks.length > 0) lines.push(`asks: ${record.asks.join("; ")}`);
    return lines.join("\n");
  }
  if (record.pending === true) {
    lines.push(`REMOTE TURN STILL RUNNING on ${String(record.alias)} (${String(record.note ?? "")}).`);
    if (Array.isArray(record.asks) && record.asks.length > 0) lines.push(`asks: ${record.asks.join("; ")}`);
    return lines.join("\n");
  }
  const remoteError = record.remoteError === void 0 ? void 0 : narrow(record.remoteError);
  if (record.terminal === "cancelled" || record.terminal === "aborted") {
    lines.push(`REMOTE TURN ${String(record.terminal).toUpperCase()} on ${String(record.alias)} (session ${String(record.sessionId)}, turn ${String(record.turn)}).`);
    if (remoteError !== void 0) lines.push(`remote error [${String(remoteError.code)}] ${String(remoteError.message)}`);
  } else if (record.terminal !== "completed") {
    lines.push(`REMOTE TURN FAILED on ${String(record.alias)}: ${String(record.terminal)}${remoteError === void 0 ? "" : ` [${String(remoteError.code)}] ${String(remoteError.message)}`}`);
  } else {
    lines.push(`remote answer from ${String(record.alias)} (session ${String(record.sessionId)}):`);
  }
  if (typeof record.answer === "string" && record.answer !== "") lines.push(record.answer);
  if (Array.isArray(record.asks) && record.asks.length > 0) lines.push(`asks: ${record.asks.join("; ")}`);
  if (record.created === true) lines.push("(a new remote session was created for this alias)");
  if (record.superseded === true) lines.push("(a different operator prompted the session after this turn ended; the result above is our own turn)");
  return lines.join("\n");
}
function renderAsks(value) {
  const record = narrow(value);
  if (record.ok !== true) return `peer_asks failed: ${String(narrow(record.error).message ?? "")}`;
  const asks = Array.isArray(record.asks) ? record.asks : [];
  if (asks.length === 0) return `no pending asks on ${String(record.alias)} (latch ${String(record.latch)})`;
  return [
    `${String(asks.length)} pending ask(s) on ${String(record.alias)}:`,
    ...asks.map((ask) => {
      if (String(ask.kind) === "question") {
        const questions = Array.isArray(ask.questions) ? ask.questions : [];
        const rendered = questions.map((question) => renderQuestion({
          id: String(question.id),
          question: String(question.question),
          options: Array.isArray(question.options) ? question.options.map((label) => ({ label })) : [],
          multiSelect: question.multiSelect === true
        })).join("; ");
        return `\u2022 ${String(ask.askId)} question ${rendered} \u2014 answer with peer_answer answers[]`;
      }
      return `\u2022 ${String(ask.askId)} ${String(ask.kind)} ${String(ask.toolName ?? "")} ${String(ask.reason ?? "")}`.trim();
    })
  ].join("\n");
}
function renderAnswer(value) {
  const record = narrow(value);
  if (record.ok === true) return `answered ${String(record.askId)} on ${String(record.alias)} \u2014 ${String(record.note ?? "settled")}`;
  const error = narrow(record.error);
  const detail = typeof record.note === "string" && record.note !== "" ? record.note : String(error.message ?? "");
  return `peer_answer failed [${String(error.code ?? "unknown")}] ${String(record.askId ?? "")}: ${detail}`;
}
export {
  Config,
  apply,
  inject,
  name,
  registerTools
};
