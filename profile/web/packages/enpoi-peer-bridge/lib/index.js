// src/index.ts
import Schema from "@deepseek-ai/schemastery";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync as mkdirSync2, writeFileSync } from "node:fs";
import { dirname as dirname3, join as join3 } from "node:path";

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

// src/caller-version.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname as dirname2, join } from "node:path";
import { fileURLToPath } from "node:url";
var CALLER_HARNESS_VERSION_ENV = "DSH_PEER_HARNESS_VERSION";
var ADJACENT_WALK_DEPTH = 6;
var CallerVersionError = class extends Error {
  /** Peer error code the tool layer reports for this failure. */
  code = "gateway/internal";
  /**
   * @param message - the failure, naming every source and the env override.
   */
  constructor(message) {
    super(message);
    this.name = "CallerVersionError";
  }
};
function manifestStringAt(path, key = "version") {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return void 0;
    const value = parsed[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
  } catch {
    return void 0;
  }
}
function adjacentPeerManifest(moduleUrl) {
  let dir = dirname2(fileURLToPath(moduleUrl));
  for (let depth = 0; depth < ADJACENT_WALK_DEPTH; depth += 1) {
    const candidate = join(dir, "node_modules", "@deepseek-ai", "dsh-api-peer", "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname2(dir);
    if (parent === dir) return void 0;
    dir = parent;
  }
  return void 0;
}
function resolveCallerHarnessVersion(sources = {}) {
  const env = sources.env ?? process.env;
  const explicit = sources.harnessVersion ?? env[CALLER_HARNESS_VERSION_ENV];
  if (typeof explicit === "string" && explicit.trim() !== "") return explicit.trim();
  const manifest = sources.peerManifestPath ?? adjacentPeerManifest(import.meta.url);
  const adjacent = manifest === void 0 ? void 0 : manifestStringAt(manifest);
  if (adjacent !== void 0) return adjacent;
  const home = sources.dshHome ?? (env.DSH_HOME !== void 0 && env.DSH_HOME !== "" ? env.DSH_HOME : join(homedir(), ".dsh"));
  const installed = manifestStringAt(join(home, "harness", "install-state.json"));
  if (installed !== void 0) return installed;
  throw new CallerVersionError(
    `cannot determine the caller harness version (no ${CALLER_HARNESS_VERSION_ENV}, no @deepseek-ai/dsh-api-peer manifest beside this plugin, and no harness/install-state.json under ${home}) \u2014 set ${CALLER_HARNESS_VERSION_ENV} to this build's version`
  );
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
var SCHEMA_DIGEST = "599b07e200d7a174273a735675729383f40e6edfa3fdfc9afb2842dd8e106d86";
var METHODS_DIGEST = "43cd7b31db35f5a557e10ec65debe4b3308e11597cf17a1656a0145fe2a4e87e";
var DEFAULT_BACKOFF = { initialMs: 250, maxMs: 4e3, factor: 2 };
var REPAIR_PAGE_LIMIT = 20;
var GAP_RECONNECT_LIMIT = 3;
var CALLER_TERMINAL_CODES = /* @__PURE__ */ new Set([
  "gateway/bad-request",
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
  boundedFollow;
  /** Negotiate against the target; a protocol mismatch surfaces `peer/version-skew`. */
  async handshake() {
    const schemaDigest = this.options.schemaDigest ?? SCHEMA_DIGEST;
    const value = await this.rpc("handshake", {
      protocolVersion: 1,
      harnessVersion: this.options.harnessVersion ?? resolveCallerHarnessVersion(),
      schemaDigest,
      device: this.options.device
    });
    this.boundedFollow = value.capabilities.includes("bounded-follow");
    if (value.capabilities.includes("shape-digest") && value.schemaDigest !== schemaDigest) {
      this.options.onCompatibilityWarning?.("peer handshake schemaDigest differs from this caller");
    }
    const methodsDigest = value.methodsDigest ?? (value.capabilities.includes("shape-digest") ? void 0 : value.schemaDigest);
    if (methodsDigest && methodsDigest !== METHODS_DIGEST) {
      this.options.onCompatibilityWarning?.("peer handshake methodsDigest differs from this caller");
    }
    return value;
  }
  /** Read the latch for one target. */
  state(target) {
    return this.rpc("state", { target });
  }
  /** List the pairings the host exposes, optionally narrowed to one resolved target. */
  list(request = {}) {
    return this.rpc("list", request);
  }
  /**
   * Read the policy-filtered chains and models one alias may select.
   * @param request - alias, participant, optional filter, cursor, and page limit.
   * @returns selectable chains/models with the policy echoed for the controller.
   */
  models(request) {
    return this.rpc("models", request);
  }
  /** Create or adopt a Session under a pairing alias. */
  create(request) {
    return this.rpc("create", request);
  }
  /** Admit a queued peer turn. */
  prompt(request) {
    return this.rpc("prompt", request);
  }
  /** Read one input receipt; a missing entry does not prove non-admission. */
  receipt(request, signal) {
    return this.rpc("receipt", request, signal);
  }
  /** Rotate a fence, extend the expiry, or revoke a bound job. */
  jobUpdate(request) {
    return this.rpc("jobUpdate", request);
  }
  /** Read authenticated readiness for one alias. */
  ready(request) {
    return this.rpc("ready", request);
  }
  /** List metadata for a worker's export files. */
  exportList(request) {
    return this.rpc("exportList", request);
  }
  /** Fetch one bounded export; the caller verifies the returned digest and size. */
  exportFetch(request) {
    return this.rpc("exportFetch", request);
  }
  /** Cancel the target's active turn. */
  cancel(request) {
    return this.rpc("cancel", request);
  }
  /** Read retained asks for the selected alias binding. */
  asks(request) {
    return this.rpc("asks", request);
  }
  /** Wait for an observation, not proof of quiescence. */
  waitQuiescent(request) {
    return this.rpc("waitQuiescent", request);
  }
  /** Settle a pending ask. */
  answer(request) {
    return this.rpc("answer", request);
  }
  /**
   * Switch one idle Session's routing for its next turn.
   * @param request - target, participant, request id, requested route or chain, and optional effort.
   * @returns the applied selection, the previous one when known, and replay status.
   */
  selectModel(request) {
    return this.rpc("selectModel", request);
  }
  /** Read one backwards history window for repair. */
  page(request, signal) {
    return this.rpc("page", request, signal);
  }
  /**
   * Cheap reachability probe: one bounded `peer.state` read.
   *
   * A sleep, a cut link, or a dead host leaves a follow socket open and silent,
   * so the follow loop cannot tell "the host is gone" from "the model is
   * thinking" without an independent call. This answers only reachability:
   * any response — including a structured error — means reachable; only a
   * transport failure or the deadline means the host did not answer.
   * @param target - resolved peer target.
   * @param options - deadline and caller cancellation.
   * @returns true when the host answered within the deadline; false when it did not.
   */
  async probe(target, options) {
    const signals = [AbortSignal.timeout(options.timeoutMs)];
    if (options.signal !== void 0) signals.push(options.signal);
    try {
      await this.rpc("state", { target }, AbortSignal.any(signals));
      return true;
    } catch (error) {
      return !(error instanceof PeerBridgeError && error.code === "peer/target-unreachable");
    }
  }
  /**
   * Open one follow generation without reconnect handling.
   * @param request - target and window options.
   * @param signal - caller cancellation closing the socket.
   * @returns frames exactly as the host sends them.
   */
  async *followOnce(request, signal) {
    if (signal.aborted) return;
    const socket = this.webSocketFactory(this.muxUrl());
    const streamId = `peer-${randomToken()}`;
    const queue = [];
    let wake;
    let closed = false;
    let opened = false;
    const openedSocket = () => opened;
    let frameNumber = 0;
    let cursor;
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
      if (frame.streamId !== streamId || frame.type !== "item" && frame.type !== "error" && frame.type !== "end") return;
      queue.push({ streamId, type: frame.type, value: frame.type === "error" ? frame.error ?? frame.value : frame.value });
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
    const openTimer = setTimeout(onAbort, 1e4).unref();
    const onOpen = () => {
      clearTimeout(openTimer);
      if (isClosed()) return;
      try {
        socket.send(JSON.stringify({ type: "open", streamId, endpoint: "peer/follow", payload: { args: { request } } }));
        opened = true;
      } catch {
        onAbort();
      }
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      while (!signal.aborted) {
        const frame = queue.shift();
        if (frame === void 0) {
          if (isClosed()) {
            if (this.boundedFollow === true && openedSocket()) yield gapAfter(cursor, "upstream-closed");
            if (!openedSocket()) throw unreachable(this.endpoint);
            return;
          }
          await new Promise((resolve) => {
            wake = resolve;
          });
          continue;
        }
        if (frame.type === "item") {
          if (typeof frame.value !== "object" || frame.value === null || !("type" in frame.value)) throw unreachable(this.endpoint);
          const value = frame.value;
          if (value.type === "gap" || value.type === "end") {
            yield value;
            return;
          }
          if ("cursor" in value) cursor = value.cursor;
          try {
            yield value;
          } finally {
            if (this.boundedFollow !== false && !isClosed() && !signal.aborted) {
              try {
                socket.send(JSON.stringify({ type: "item", streamId, value: { type: "ack", frame: ++frameNumber } }));
              } catch {
                onAbort();
              }
            }
          }
          continue;
        }
        if (frame.type === "error") {
          throw decodeFailure(frame.value, this.endpoint);
        }
        if (this.boundedFollow === true) yield gapAfter(cursor, "upstream-closed");
        return;
      }
    } finally {
      clearTimeout(openTimer);
      signal.removeEventListener("abort", onAbort);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onAbort);
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
    let boundSession;
    let attempt = 0;
    let gapAttempts = 0;
    let recovering = false;
    let recoveryThrough = -1;
    while (!signal.aborted) {
      let progressed = false;
      let lost;
      try {
        for await (const frame of this.followOnce(request, signal)) {
          if (frame.type === "gap") {
            lost = frame;
            break;
          }
          progressed = true;
          if (frame.type === "snapshot") {
            if (boundSession !== void 0 && frame.target.sessionId !== boundSession) {
              yield { type: "end", reason: "target-detached" };
              return;
            }
            boundSession = frame.target.sessionId;
            if (recovering && frame.cursor < recoveryThrough) {
              throw new PeerBridgeError("peer/gap", "The follow snapshot is older than the required repair cut.", this.endpoint);
            }
            if (lastCursor !== void 0) {
              const oldest = frame.records[0]?.seq ?? frame.cursor + 1;
              if (oldest > lastCursor + 1) {
                const target = { kind: "session", sessionId: frame.target.sessionId };
                yield* this.repairForward(target, lastCursor, oldest, signal, recovering);
              }
            }
            lastCursor = Math.max(lastCursor ?? -1, frame.cursor);
            recovering = false;
            recoveryThrough = -1;
          } else if (frame.type === "event") {
            if (frame.cursor > (lastCursor ?? -1)) gapAttempts = 0;
            lastCursor = Math.max(lastCursor ?? -1, frame.cursor);
          } else if (frame.type === "state") {
            lastCursor = Math.max(lastCursor ?? -1, frame.cursor);
          }
          yield frame;
          if (frame.type === "end") return;
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof PeerBridgeError) {
          if (CALLER_TERMINAL_CODES.has(error.code)) throw error;
          if (error.code === "peer/unavailable" && error.details.reason === "follow-capacity") {
            throw new PeerBridgeError(error.code, "Peer follow is at capacity; back off before reopening.", this.endpoint, { reason: "follow-capacity" });
          }
          if (error.code === "peer/gap") lost = gapFromError(error.details.gap, lastCursor);
        }
      }
      if (signal.aborted) return;
      if (lost !== void 0 || recovering) {
        recovering = true;
        gapAttempts += 1;
        if (lost !== void 0) {
          recoveryThrough = Math.max(recoveryThrough, lost.toSeq ?? -1, lastCursor ?? -1);
          if (lost.fromSeq !== null) lastCursor = Math.min(lastCursor ?? lost.fromSeq - 1, lost.fromSeq - 1);
          else if (lastCursor === void 0 && lost.toSeq !== null) lastCursor = -1;
          yield lost;
        }
        if (gapAttempts > Math.min(this.maxReconnects ?? GAP_RECONNECT_LIMIT, GAP_RECONNECT_LIMIT)) {
          throw new PeerBridgeError("peer/gap", "Peer follow could not repair history within the retry limit; retry following the same request.", this.endpoint);
        }
      }
      attempt = recovering ? gapAttempts : progressed ? 1 : attempt + 1;
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
   * @param strict - refuse incomplete repair after an explicit gap.
   * @returns the missing records in ascending seq order.
   */
  async *repairForward(target, fromExclusive, toExclusive, signal, strict = false) {
    const collected = [];
    let throughSeq = toExclusive - 1;
    let hole;
    let pages = 0;
    let complete = throughSeq <= fromExclusive;
    while (pages < REPAIR_PAGE_LIMIT) {
      if (signal.aborted || throughSeq <= fromExclusive) break;
      const value = await this.page({ target, throughSeq, maxMessages: this.pageSize }, signal);
      pages += 1;
      if (value.records.length === 0) {
        complete = !value.hasMore;
        hole = { from: fromExclusive + 1, to: throughSeq + 1 };
        break;
      }
      for (const record of value.records) {
        if (record.seq > fromExclusive && record.seq < toExclusive) collected.push(record);
      }
      const oldest = value.records[0]?.seq;
      if (oldest === void 0 || oldest <= fromExclusive + 1 || !value.hasMore) {
        complete = true;
        if (oldest !== void 0 && oldest > fromExclusive + 1) hole = { from: fromExclusive + 1, to: oldest };
        break;
      }
      throughSeq = oldest - 1;
    }
    if (strict && !complete && !signal.aborted) throw new PeerBridgeError("peer/gap", "Peer history repair exceeded its page limit.", this.endpoint);
    if (strict) hole = void 0;
    if (!strict && hole === void 0 && !signal.aborted && throughSeq > fromExclusive) {
      hole = { from: fromExclusive + 1, to: throughSeq + 1 };
    }
    if (hole !== void 0) this.options.onWarning?.(hole);
    collected.sort((left, right) => left.seq - right.seq);
    for (const record of collected) yield { type: "event", record, cursor: record.seq };
  }
  async rpc(method, args, signal) {
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
        }),
        ...signal === void 0 ? {} : { signal }
      });
    } catch (error) {
      throw unreachable(this.endpoint, error);
    }
    if (!response.ok) {
      throw new PeerBridgeError("peer/target-unreachable", `peer ${method} failed over HTTP ${String(response.status)}`, this.endpoint, { endpoint: this.endpoint });
    }
    let body;
    try {
      body = await response.json();
    } catch (error) {
      throw unreachable(this.endpoint, error);
    }
    const result = body?.result;
    if (result?.ok !== true && result?.ok !== false) {
      throw new PeerBridgeError("gateway/internal", `peer ${method} returned no result envelope`, this.endpoint, { reason: "missing-result-envelope" });
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
function gapAfter(cursor, reason = "sequence-discontinuity") {
  return { type: "gap", fromSeq: cursor === void 0 ? null : cursor + 1, toSeq: null, reason, resync: "refollow-and-page" };
}
function gapFromError(wire, cursor) {
  const gap = gapAfter(cursor);
  if (typeof wire !== "object" || wire === null || !("type" in wire) || wire.type !== "gap") return gap;
  const fromSeq = "fromSeq" in wire && typeof wire.fromSeq === "number" && Number.isSafeInteger(wire.fromSeq) ? wire.fromSeq : gap.fromSeq;
  const toSeq = "toSeq" in wire && typeof wire.toSeq === "number" && Number.isSafeInteger(wire.toSeq) ? wire.toSeq : null;
  return { ...gap, fromSeq, toSeq };
}
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
import { readFileSync as readFileSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
function defaultPairingsPath(env = process.env) {
  const home = env.DSH_HOME !== void 0 && env.DSH_HOME !== "" ? env.DSH_HOME : join2(homedir2(), ".dsh");
  return join2(home, "pairings.yaml");
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
    raw = readFileSync2(path, "utf8");
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
  if (Object.hasOwn(entry, "token")) {
    throw new PairingDocumentError(
      `${subject}: ambiguous key "token" is not allowed; use "tokenHash" or "inboundToken" for inbound auth, or "outboundToken" for outbound calls`,
      1
    );
  }
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
  const outboundToken = optionalString("outboundToken");
  const remoteSessionId = optionalString("remoteSessionId");
  const sessionId = optionalString("sessionId");
  return {
    alias,
    peer,
    ...endpoint === void 0 ? {} : { endpoint },
    ...exposure === void 0 ? {} : { exposure },
    ...outboundToken === void 0 ? {} : { outboundToken },
    ...remoteSessionId === void 0 ? {} : { remoteSessionId },
    ...sessionId === void 0 ? {} : { sessionId },
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
  maxReconnects: live(Schema.number()),
  probeIntervalMs: live(Schema.number())
});
var DEFAULT_WAIT_MS = 3e5;
var DEFAULT_PROBE_INTERVAL_MS = 3e4;
var HOST_PROBE_TIMEOUT_MS = 4e3;
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
  const noticesPath = config.noticesPath ?? defaultNoticesPath(dirname3(pairingsPath));
  const waitMs = config.waitMs ?? DEFAULT_WAIT_MS;
  const settleMs = config.settleMs ?? DEFAULT_SETTLE_QUIET_MS;
  const probeIntervalMs = config.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
  const effectiveDeps = {
    ...deps,
    onWarning: deps.onWarning ?? ((hole) => {
      ctx.logger?.warn?.(`enpoi-peer-bridge: peer follow history hole [${String(hole.from)}, ${String(hole.to)}) \u2014 records in that range are missing locally`);
    }),
    onCompatibilityWarning: deps.onCompatibilityWarning ?? ((message) => {
      ctx.logger?.warn?.(`enpoi-peer-bridge: ${message}`);
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
              instanceId: { type: "string" },
              schemaDigest: { type: "string" },
              methodsDigest: { type: "string" },
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
          stopIntent: stopIntentSchema(),
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
        warnAskCapabilities(handshake, effectiveDeps, ["stop-intent"]);
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
            instanceId: handshake.instanceId,
            schemaDigest: handshake.schemaDigest,
            methodsDigest: handshake.methodsDigest,
            capabilities: [...handshake.capabilities]
          },
          exposure: stateValue?.target.exposure ?? pairing.exposure ?? "unknown",
          sessionId: stateValue?.target.sessionId ?? pairing.remoteSessionId ?? "",
          bound,
          latch: state?.latch ?? "unknown",
          latchSource: state?.source ?? "unknown",
          activeDescendants: state?.activeDescendants ?? 0,
          descendantsExact: state?.descendantsExact ?? false,
          stopIntent: state?.stopIntent,
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
    name: "peer_models",
    description: [
      "List the models and chains a paired peer lets you select for its sessions, with each route's",
      "capabilities (tool calling, vision, context window, zero price, gating, whether prompts train on",
      "it, and the reasoning efforts it accepts) and each chain member's live state (ready, cooling",
      "down until a time, or retired). Read-only. Use it before choosing a route for peer_ask or",
      "peer_switch_model. The peer enforces its own allow list, so the result already excludes what you",
      "may not use; when the peer cannot offer model choice at all, the result says to upgrade the host.",
      "The alias names the pairing (the member device in the fleet convention) and is the same string",
      "on both devices \u2014 it is NOT the target host name."
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        alias: { type: "string", description: "Pairing alias of the peer session." },
        limit: { type: "number", description: "Maximum rows in this page; the peer clamps it." },
        cursor: { type: "string", description: "Opaque cursor from a previous page's nextCursor." },
        zeroPrice: { type: "boolean", description: "Only routes the peer can prove are free of charge." },
        tools: { type: "boolean", description: "Only routes the peer can prove support tool calling." }
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
          chains: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                label: { type: "string" },
                dynamic: { type: "boolean" },
                members: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      provider: { type: "string" },
                      model: { type: "string" },
                      state: { type: "string", enum: ["ready", "cooldown", "deprecated"] },
                      cooldownUntil: { type: "number" }
                    },
                    required: ["provider", "model", "state"]
                  }
                }
              },
              required: ["id", "dynamic", "members"]
            }
          },
          models: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                provider: { type: "string" },
                model: { type: "string" },
                tools: { oneOf: [{ type: "boolean" }, { type: "string" }] },
                vision: { oneOf: [{ type: "boolean" }, { type: "string" }] },
                contextWindow: { type: "number" },
                zeroPrice: { oneOf: [{ type: "boolean" }, { type: "string" }] },
                gated: { oneOf: [{ type: "boolean" }, { type: "string" }] },
                trainsOnData: { type: "string", enum: ["yes", "no", "unknown"] },
                reasoningEfforts: { type: "array", items: { type: "string" } }
              },
              required: ["provider", "model", "tools", "vision", "zeroPrice", "gated", "trainsOnData", "reasoningEfforts"]
            }
          },
          nextCursor: { type: "string" },
          selectable: {
            type: "object",
            additionalProperties: false,
            properties: {
              chains: { type: "array", items: { type: "string" } },
              models: { type: "array", items: { type: "string" } },
              reasoningEfforts: { type: "array", items: { type: "string" } },
              requireZeroPrice: { type: "boolean" },
              requireNoTraining: { type: "boolean" },
              requireTools: { type: "boolean" },
              allowSwitch: { type: "string", enum: ["never", "idle-only"] }
            },
            required: ["chains", "models", "requireZeroPrice", "requireNoTraining", "requireTools", "allowSwitch"]
          },
          error: failureSchema()
        },
        required: ["ok"]
      },
      render: (_args, value) => [{ type: "text", text: renderModels(value) }]
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const request = narrow(args);
      const alias = requireAlias(request.alias);
      const filter = modelsFilterOf(request);
      if (filter !== void 0 && !filter.ok) return badRequest(filter.message);
      const limit = positiveIntegerOf("limit", request.limit);
      if (limit !== void 0 && !limit.ok) return badRequest(limit.message);
      const cursor = nonEmptyTextOf("cursor", request.cursor);
      if (cursor !== void 0 && !cursor.ok) return badRequest(cursor.message);
      const { pairing, document } = resolveEntry(pairingsPath, alias);
      const client = makeClient(pairing, config, document.device, effectiveDeps);
      try {
        const handshake = await client.handshake();
        const gap = capabilityGap(handshake.capabilities, "model-discovery");
        if (gap !== void 0) return gap;
        const value = await client.models({
          alias,
          participant: participantOf(config, document),
          ...filter === void 0 ? {} : { filter: filter.value },
          ...cursor === void 0 ? {} : { cursor: cursor.value },
          ...limit === void 0 ? {} : { limit: limit.value }
        });
        return {
          ok: true,
          alias,
          chains: value.chains,
          models: value.models,
          ...value.nextCursor === void 0 ? {} : { nextCursor: value.nextCursor },
          selectable: value.selectableByThisAlias
        };
      } catch (error) {
        return failureFrom(error, pairing.endpoint);
      }
    }
  });
  ctx.tools.register({
    name: "peer_switch_model",
    description: [
      "Move a paired peer session to another model or chain for its next turn. The session must be",
      "idle; a running or waiting session refuses the switch. Name provider and model, or a chain id",
      "(a chain alone runs its first ready member), optionally with a reasoning effort. The peer",
      "enforces its own allow list, so a refusal names the reason and the refused route; read",
      "peer_models first to see what is selectable. Mutating: this changes the remote session, not",
      "this one. The result reports the applied route, the previous one when known, and whether this",
      "call was an already-applied retry.",
      "The alias names the pairing (the member device in the fleet convention) and is the same string",
      "on both devices \u2014 it is NOT the target host name."
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        alias: { type: "string", description: "Pairing alias of the peer session." },
        provider: { type: "string", description: "Provider id of the route to run (with model)." },
        model: { type: "string", description: "Model id of the route to run (with provider)." },
        chain: { type: "string", description: "Chain id to run instead of, or narrowing, an explicit route." },
        reasoningEffort: { type: "string", description: "Adapter-supported reasoning effort for the chosen route." },
        requestId: {
          type: "string",
          description: "Optional retry key: reuse the value from a failed attempt to replay it instead of switching twice."
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
          alias: { type: "string" },
          requestId: { type: "string" },
          selection: {
            type: "object",
            additionalProperties: false,
            properties: {
              provider: { type: "string" },
              model: { type: "string" },
              chain: { type: "string" },
              reasoningEffort: { type: "string" }
            },
            required: ["provider", "model"]
          },
          previous: {
            type: "object",
            additionalProperties: false,
            properties: {
              provider: { type: "string" },
              model: { type: "string" },
              chain: { type: "string" },
              reasoningEffort: { type: "string" }
            },
            required: ["provider", "model"]
          },
          replayed: { type: "boolean" },
          note: { type: "string" },
          error: failureSchema()
        },
        required: ["ok"]
      },
      render: (_args, value) => [{ type: "text", text: renderSwitch(value) }]
    },
    async execute(args) {
      const request = narrow(args);
      const alias = requireAlias(request.alias);
      const route = switchRouteOf(request);
      if (!route.ok) return badRequest(route.message);
      const requestId = nonEmptyTextOf("requestId", request.requestId);
      if (requestId !== void 0 && !requestId.ok) return badRequest(requestId.message);
      const { pairing, document } = resolveEntry(pairingsPath, alias);
      const client = makeClient(pairing, config, document.device, effectiveDeps);
      const id = requestId === void 0 ? `peer-bridge-${randomUUID()}` : requestId.value;
      try {
        const handshake = await client.handshake();
        const gap = capabilityGap(handshake.capabilities, "model-switch");
        if (gap !== void 0) return gap;
        const value = await client.selectModel({
          target: targetOf(pairing),
          participant: participantOf(config, document),
          requestId: id,
          provider: route.value.provider ?? "",
          model: route.value.model ?? "",
          ...route.value.chain === void 0 ? {} : { chain: route.value.chain },
          ...route.value.reasoningEffort === void 0 ? {} : { reasoningEffort: route.value.reasoningEffort }
        });
        return {
          ok: true,
          alias,
          requestId: id,
          selection: value.selected,
          ...value.previous === void 0 ? {} : { previous: value.previous },
          replayed: value.replayed === true,
          note: value.replayed === true ? "this switch was already applied; the result is the original one" : "the remote session will run the selected route on its next turn"
        };
      } catch (error) {
        const failure = failureFrom(error, pairing.endpoint);
        return { ...failure, alias, requestId: id };
      }
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
      "resume set to the returned requestId to follow the same turn to completion. A host that goes",
      "silent mid-follow (for example a sleeping laptop) is detected by a reachability probe after",
      'the configured probeIntervalMs and returns status "host_unreachable" without cancelling the',
      "remote turn. Remote asks that",
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
        },
        requestId: { type: "string", description: "Retry key from a lost reply. Retry with the same message and create options; use resume to follow without resending." },
        provider: { type: "string", description: "When this call creates the session: provider of the route it starts on (with model)." },
        model: { type: "string", description: "When this call creates the session: model it starts on (with provider)." },
        chain: { type: "string", description: "When this call creates the session: chain id it starts on (its first ready member runs)." },
        reasoningEffort: { type: "string", description: "When this call creates the session: reasoning effort for the chosen route or chain." },
        maxTotalTokens: { type: "number", description: "When this call creates the session: token ceiling; the peer stops the session when it is reached." }
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
          createRequestId: { type: "string" },
          disposition: { type: "string" },
          terminalState: { type: "string" },
          instanceId: { type: "string" },
          replayed: { type: "boolean" },
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
      const requestId = nonEmptyTextOf("requestId", request.requestId);
      if (requestId !== void 0 && !requestId.ok) return badRequest(requestId.message);
      if (resume !== void 0 && requestId !== void 0) return badRequest("peer_ask takes either resume or requestId, not both");
      if (resume !== void 0 && message.trim() !== "") {
        return { ok: false, error: { code: "gateway/bad-request", message: "resume continues a followed turn; drop message (the first peer_ask already sent it)" } };
      }
      if (resume === void 0 && message.trim() === "") return { ok: false, error: { code: "gateway/bad-request", message: "peer_ask needs a non-empty message" } };
      if (message.length > MAX_MESSAGE_CHARS) {
        return { ok: false, error: { code: "gateway/bad-request", message: `peer_ask message exceeds ${String(MAX_MESSAGE_CHARS)} characters` } };
      }
      const createRouting = askCreateRoutingOf(request);
      if (!createRouting.ok) return badRequest(createRouting.message);
      const requestedWait = typeof request.waitMs === "number" && Number.isFinite(request.waitMs) && request.waitMs > 0 ? Math.trunc(request.waitMs) : waitMs;
      return runAsk(ctx, {
        pairingsPath,
        noticesPath,
        waitMs: requestedWait,
        settleMs,
        probeIntervalMs,
        config,
        signal: exec.signal,
        agent: exec.agent,
        alias,
        message,
        ...resume === void 0 ? {} : { resume },
        ...requestId === void 0 ? {} : { requestId: requestId.value },
        ...exec.agent?.session === void 0 ? {} : { toolCallKey: JSON.stringify([exec.agent.session.id, exec.callId]) },
        createRouting: createRouting.value,
        allowCreate: true,
        deps: effectiveDeps
      });
    }
  });
  ctx.tools.register({
    name: "peer_asks",
    description: "List retained asks on a paired peer session, including expired asks. Only pending approvals and questions can take a new decision with peer_answer.",
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
          instanceId: { type: "string" },
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
      const { pairing, document } = resolveEntry(pairingsPath, alias);
      const client = makeClient(pairing, config, document.device, effectiveDeps);
      try {
        const handshake = await client.handshake();
        if (handshake.capabilities.includes("durable-asks")) {
          const value2 = await client.asks({ alias, sessionId: pairing.remoteSessionId });
          return {
            ok: true,
            alias,
            instanceId: value2.instanceId,
            sessionId: pairing.remoteSessionId ?? value2.asks[0]?.sessionId,
            asks: value2.asks.map((ask) => ({ ...askPayload(ask), state: ask.state, settlementReason: ask.settlementReason, answeredBy: ask.answeredBy }))
          };
        }
        warnAskCapabilities(handshake, effectiveDeps, ["durable-asks"]);
        const value = await client.state(targetOf(pairing));
        return {
          ok: true,
          alias,
          sessionId: value.target.sessionId,
          latch: value.state.latch,
          asks: value.state.pendingAsks.map((ask) => ({ ...askPayload(ask), state: "pending" }))
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
      "the ids and options). Reuse requestId and the same decision after a lost reply; an expired ask",
      "cannot take a new decision. A malformed selection is rejected here with the",
      "reason and never reaches the host."
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        alias: { type: "string", description: "Pairing alias of the peer session." },
        askId: { type: "string", description: "Remote ask id from peer_asks or a peer_ask result." },
        requestId: { type: "string", description: "Retry ID from an earlier answer; reuse only with the same decision." },
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
          requestId: { type: "string" },
          replayed: { type: "boolean" },
          payloadHash: { type: "string" },
          instanceId: { type: "string" },
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
      const retry = nonEmptyTextOf("requestId", request.requestId);
      if (retry !== void 0 && !retry.ok) return badRequest(retry.message);
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
      const participant = participantOf(config, document);
      let target = targetOf(pairing);
      let answer;
      let durableAsks = false;
      try {
        const handshake = await client.handshake();
        warnAskCapabilities(handshake, effectiveDeps, ["ask-idempotent-answer"]);
        durableAsks = handshake.capabilities.includes("durable-asks");
      } catch (error) {
        return failureFrom(error, pairing.endpoint);
      }
      if (outcome !== void 0) {
        answer = { kind: "approval", outcome };
      } else {
        const parsed = parseQuestionSelections(rawAnswers ?? []);
        if (!parsed.ok) return badRequest(parsed.message);
        let pending;
        try {
          if (durableAsks) {
            const value = await client.asks({ alias, sessionId: pairing.remoteSessionId });
            const retained = value.asks.find((candidate) => candidate.askId === askId);
            pending = retained;
            if (retained !== void 0) target = { kind: "session", sessionId: retained.sessionId };
          } else {
            const value = await client.state(target);
            pending = value.state.pendingAsks.find((candidate) => candidate.askId === askId);
          }
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
      let requestId;
      try {
        requestId = retry?.value ?? recordAnswerId(dirname3(noticesPath), pairing, participant, askId);
      } catch {
        return { ok: false, settled: false, error: { code: "peer/unavailable", message: "Could not record the local answer retry ID; no answer was sent." } };
      }
      try {
        const value = await client.answer({
          target,
          participant,
          askId,
          requestId,
          answer
        });
        return {
          ok: value.accepted === true && value.settled === true,
          alias,
          askId,
          requestId,
          settled: value.settled === true,
          replayed: value.replayed,
          payloadHash: value.payloadHash,
          instanceId: value.instanceId,
          confirmation: "confirmed",
          note: value.replayed === true ? "The host replayed the recorded answer; no new decision was delivered." : answer.kind === "question" ? "question settled; the first answer won" : "ask settled; the first answer won"
        };
      } catch (error) {
        const conflict = error instanceof PeerBridgeError && error.code === "peer/conflict";
        if (error instanceof PeerBridgeError && (error.code === "peer/target-unreachable" || error.details.reason === "missing-result-envelope")) {
          const reread = await client.state(target).catch(() => void 0);
          const gone = reread !== void 0 && !reread.state.pendingAsks.some((candidate) => candidate.askId === askId);
          const message = gone ? "The answer reply was lost and the ask is no longer pending. This does not establish who answered or whether it expired; reuse the same request ID and decision to check for replay." : "The answer reply was lost; reuse the same request ID and decision to check for replay.";
          return { ok: false, alias, askId, requestId, settled: false, confirmation: "lost", note: message, error: { code: "peer/target-unreachable", message } };
        }
        const refusal = answerRefusal(error);
        const failure = failureFrom(error, pairing.endpoint);
        return {
          ok: false,
          alias,
          askId,
          requestId,
          settled: false,
          note: refusal ?? (conflict ? "another participant already answered this ask (peer/conflict) \u2014 report it; do not retry blind" : failure.error.message),
          error: refusal === void 0 ? failure.error : { ...failure.error, message: refusal }
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
          stopIntent: stopIntentSchema(),
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
          text: record.ok === true ? `${record.cancelled === true ? "Stop requested on" : "No active turn reported on"} ${String(record.alias)} \u2014 ${String(record.note ?? "")}${record.stopIntent === void 0 ? "" : `
${stopIntentText(record.stopIntent)}`}` : `peer_cancel failed: ${String(narrow(record.error).message ?? "")}`
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
        if (value.stopIntent === void 0) effectiveDeps.onCompatibilityWarning?.("peer cancel did not report stop-intent");
        return {
          ok: true,
          alias,
          cancelled: value.cancelled,
          stopIntent: value.stopIntent,
          confirmation: "confirmed",
          note: value.cancelled ? "remote Stop was requested; this does not prove teardown" : "remote session had no active turn"
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
              stopIntent: reread.state.stopIntent,
              note: "the cancel confirmation was lost (transport failure); the remote reports no active turn \u2014 it may have completed or been cancelled"
            };
          }
        }
        return failureFrom(error, pairing.endpoint);
      }
    }
  });
}
function warnAskCapabilities(host, deps, capabilities) {
  for (const capability of capabilities) {
    if (!host.capabilities.includes(capability)) deps.onCompatibilityWarning?.(`peer host does not advertise ${capability}`);
  }
}
function lostInputReply(client, kind, alias, requestId, createRequestId, error) {
  if (!(error instanceof PeerBridgeError)) return void 0;
  const reason = error.details.reason;
  if (error.code !== "peer/target-unreachable" && reason !== "missing-result-envelope" && !(error.code === "peer/unavailable" && reason === "receipt-finalize-failed")) return void 0;
  return (async () => {
    const receipt = await client.receipt({ alias, requestId: kind === "create" ? createRequestId : requestId, kind }, AbortSignal.timeout(HOST_PROBE_TIMEOUT_MS)).catch(() => void 0);
    const dispositions = kind === "create" ? ["created", "adopted"] : ["queued", "claimed", "cancelled_before_dispatch", "terminal"];
    const disposition = receipt?.found === true && dispositions.includes(receipt.disposition) ? receipt.disposition : "unknown";
    return {
      ok: false,
      alias,
      requestId,
      ...kind === "create" ? { createRequestId } : {},
      disposition,
      sessionId: receipt?.sessionId,
      instanceId: receipt?.instanceId,
      terminalState: receipt?.terminalState,
      error: { code: error.code, message: `Peer ${kind} reply could not be confirmed; receipt disposition: ${disposition}.` }
    };
  })();
}
async function runAsk(ctx, options) {
  const { pairing, document } = resolveEntry(options.pairingsPath, options.alias);
  const client = makeClient(pairing, options.config, document.device, options.deps);
  const participant = participantOf(options.config, document);
  const resumed = options.resume !== void 0 && options.resume !== "";
  const requestId = options.resume ?? options.requestId ?? (options.toolCallKey === void 0 ? `peer-bridge-${randomUUID()}` : `peer-bridge-${createHash("sha256").update(options.toolCallKey).digest("hex")}`);
  const createRequestId = `peer-bridge-create-${createHash("sha256").update(requestId).digest("hex")}`;
  let created = false;
  let createAttempted = false;
  let handshake;
  try {
    handshake = await client.handshake();
    warnAskCapabilities(handshake, options.deps, ["bounded-follow", "ask-idempotent-answer"]);
  } catch (error) {
    return failureFrom(error, pairing.endpoint);
  }
  let requestedTarget = targetOf(pairing);
  let baseline;
  const createOrReplay = async () => {
    createAttempted = true;
    const defaults = pairing.create ?? {};
    const routeOverride = options.createRouting.provider !== void 0 || options.createRouting.chain !== void 0;
    const routing = { ...routeOverride ? {} : pairing.createRouting ?? {}, ...options.createRouting };
    warnAskCapabilities(handshake, options.deps, [
      "session-create",
      "create-receipts",
      ...routing.provider !== void 0 || routing.chain !== void 0 ? ["model-routing-at-create"] : [],
      ...routing.maxTotalTokens === void 0 ? [] : ["token-ceiling"]
    ]);
    const value = await client.create({
      alias: pairing.alias,
      participant,
      requestId: createRequestId,
      ...typeof defaults.cwd === "string" ? { cwd: defaults.cwd } : {},
      ...typeof defaults.agentPreset === "string" ? { agentPreset: defaults.agentPreset } : {},
      ...routing
    });
    created = value.created;
    requestedTarget = { kind: "session", sessionId: value.target.sessionId };
    return client.state(requestedTarget);
  };
  try {
    baseline = await client.state(requestedTarget);
  } catch (error) {
    const code = error instanceof PeerBridgeError ? error.code : "";
    if (resumed || !options.allowCreate || requestedTarget.kind !== "alias" || code !== "peer/not-paired" && code !== "peer/not-found") {
      return failureFrom(error, pairing.endpoint);
    }
    try {
      baseline = await createOrReplay();
    } catch (createError) {
      return lostInputReply(client, "create", pairing.alias, requestId, createRequestId, createError) ?? { ...failureFrom(createError, pairing.endpoint), requestId, createRequestId };
    }
  }
  if (!resumed && !createAttempted && requestedTarget.kind === "alias" && handshake.capabilities.includes("input-disposition") && (options.requestId !== void 0 || Object.keys(options.createRouting).length > 0)) {
    try {
      const prior = await client.receipt({ alias: pairing.alias, requestId: createRequestId, kind: "create" }, AbortSignal.timeout(HOST_PROBE_TIMEOUT_MS));
      if (prior.found) baseline = await createOrReplay();
    } catch (error) {
      return (createAttempted ? lostInputReply(client, "create", pairing.alias, requestId, createRequestId, error) : void 0) ?? { ...failureFrom(error, pairing.endpoint), requestId, createRequestId };
    }
  }
  if (!createAttempted && Object.keys(options.createRouting).length > 0) {
    return badRequest(resumed ? "peer_ask resume cannot change the model; call peer_switch_model first if the turn needs another route" : "peer_ask model options apply only when this call creates the session; this session already exists \u2014 use peer_switch_model to change its model");
  }
  let prompt;
  if (!resumed) {
    warnAskCapabilities(handshake, options.deps, ["prompt-receipts", "input-disposition"]);
    try {
      if (requestedTarget.kind === "alias") {
        let sessionId = baseline.target.sessionId;
        if (options.requestId !== void 0 && handshake.capabilities.includes("input-disposition")) {
          const prior = await client.receipt({ alias: pairing.alias, requestId, kind: "prompt" }, AbortSignal.timeout(HOST_PROBE_TIMEOUT_MS));
          if (prior.found && prior.sessionId !== void 0 && prior.sessionId !== sessionId) {
            requestedTarget = { kind: "session", sessionId: prior.sessionId };
            baseline = await client.state(requestedTarget);
            sessionId = baseline.target.sessionId;
          }
        }
        requestedTarget = { kind: "session", sessionId };
      }
    } catch (error) {
      return { ...failureFrom(error, pairing.endpoint), requestId };
    }
    try {
      prompt = await client.prompt({
        target: requestedTarget,
        participant,
        requestId,
        content: [{ type: "text", text: options.message }],
        hopCount: 0
      });
    } catch (error) {
      return lostInputReply(client, "prompt", pairing.alias, requestId, createRequestId, error) ?? { ...failureFrom(error, pairing.endpoint), requestId };
    }
  }
  const input = {
    ...createAttempted ? { createRequestId } : {},
    ...prompt?.disposition === void 0 ? {} : { disposition: prompt.disposition },
    ...prompt?.terminalState === void 0 ? {} : { terminalState: prompt.terminalState },
    ...prompt?.replayed === void 0 ? {} : { replayed: prompt.replayed },
    instanceId: prompt?.instanceId ?? handshake.instanceId
  };
  const baselineTurn = options.requestId !== void 0 || prompt?.replayed === true ? 0 : baseline.state.lastTurnEnd?.turn ?? 0;
  if (prompt?.disposition === "cancelled_before_dispatch") {
    return { ...input, ok: false, alias: pairing.alias, sessionId: baseline.target.sessionId, requestId, created, admitted: true };
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
  let lastFrameAt = Date.now();
  let hostSilent = false;
  const watchdog = options.probeIntervalMs > 0 ? (async () => {
    while (!controller.signal.aborted) {
      await delay2(options.probeIntervalMs, controller.signal);
      if (controller.signal.aborted) return;
      if (Date.now() - lastFrameAt < options.probeIntervalMs) continue;
      const reachable = await client.probe(requestedTarget, { timeoutMs: HOST_PROBE_TIMEOUT_MS, signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!reachable) {
        hostSilent = true;
        controller.abort();
        return;
      }
    }
  })() : void 0;
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
  let repairing = false;
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
  const settledNow = () => !repairing && isPeerSessionSettled({
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
      lastFrameAt = Date.now();
      if (frame.type === "gap") {
        repairing = true;
        clearQuiet();
        continue;
      }
      if (frame.type === "snapshot") {
        repairing = false;
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
      if (repairing) continue;
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
    if (!timedOut && !controller.signal.aborted) return { ...failureFrom(error, pairing.endpoint), ...input, requestId, admitted, alias: pairing.alias, sessionId: baseline.target.sessionId };
  } finally {
    clearTimeout(timer);
    clearQuiet();
    options.signal.removeEventListener("abort", relayAbort);
    controller.abort();
    await Promise.allSettled([...inFlight, ...watchdog === void 0 ? [] : [watchdog]]);
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
  if (hostSilent) {
    return {
      ...input,
      ok: false,
      pending: true,
      status: "host_unreachable",
      settled: false,
      alias: pairing.alias,
      sessionId: baseline.target.sessionId,
      created,
      requestId,
      admitted,
      ...resumed ? { resumed: true } : {},
      answer: answerParts.join("\n").trim(),
      asks: askLines(asks),
      pendingAsks: pendingNow.map(askPayload),
      latch,
      cursor,
      note: [
        `the remote host stopped answering mid-turn (no frame for ${String(options.probeIntervalMs)}ms and the reachability probe failed) \u2014 it may be asleep`,
        "the remote turn was NOT cancelled and may resume if the host wakes",
        `call peer_ask again with resume: ${JSON.stringify(requestId)} to re-follow`
      ].join(" \u2014 ")
    };
  }
  if (detached) {
    return {
      ...input,
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
      ...input,
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
      ...input,
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
  if (abandoned && !repairing) {
    return {
      ...input,
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
      ...input,
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
      note: repairing ? "Peer follow lost continuity; history repair did not finish. Follow again to collect the remainder." : `remote turn ${String(terminal.turn)} ended: ${terminal.reason} but the session was not settled when following stopped (${unsettledSummary(latch, activeDescendants, pendingAskCount)}) \u2014 follow again to collect the remainder`
    };
  }
  if (terminal.reason !== "completed") {
    return {
      ...input,
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
    ...input,
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
      await relayAnswer(client, noticesPath, pairing, target, participant, ask.askId, { kind: "approval", outcome: mapped.outcome }, record, mapped.note);
    } catch (error) {
      const code = error instanceof PeerBridgeError ? error.code : "unknown";
      record.relay = code === "peer/conflict" ? "conflict" : code === "peer/not-found" ? "not-found" : "failed";
      record.note = answerRefusal(error) ?? (code === "peer/conflict" ? "another participant answered first (peer/conflict) \u2014 not retried" : `relay failed [${code}]${record.answerRequestId === void 0 ? "" : "; reuse the answer request ID with the same decision"}`);
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
    await relayAnswer(client, noticesPath, pairing, target, participant, ask.askId, { kind: "question", answer }, record, "local question answered \u2192 relayed");
  } catch (error) {
    const code = error instanceof PeerBridgeError ? error.code : "unknown";
    record.relay = code === "peer/conflict" ? "conflict" : code === "peer/not-found" ? "not-found" : "failed";
    record.note = answerRefusal(error) ?? (code === "peer/conflict" ? "another participant answered first (peer/conflict) \u2014 not retried" : `relay failed [${code}]${record.answerRequestId === void 0 ? "" : "; reuse the answer request ID with the same decision"}`);
  }
}
async function relayAnswer(client, noticesPath, pairing, target, participant, askId, answer, record, note) {
  const requestId = recordAnswerId(dirname3(noticesPath), pairing, participant, askId);
  record.answerRequestId = requestId;
  const result = await client.answer({ target, participant, askId, requestId, answer });
  if (result.accepted !== true || result.settled !== true) {
    record.relay = "failed";
    record.note = "The host did not confirm answer settlement.";
    return;
  }
  record.relay = "settled";
  record.note = result.replayed === true ? "the host replayed the recorded answer; no new decision was delivered" : note;
}
function recordAnswerId(directory, pairing, participant, askId) {
  const fingerprint = createHash("sha256").update(JSON.stringify([pairing.endpoint, pairing.alias, participant.device, participant.name, askId])).digest("hex");
  const requestId = `peer-bridge-answer-${fingerprint}`;
  const store = join3(directory, "answer-requests");
  mkdirSync2(store, { recursive: true, mode: 448 });
  try {
    writeFileSync(join3(store, fingerprint), `${requestId}
`, { flag: "wx", mode: 384 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  return requestId;
}
function answerRefusal(error) {
  if (!(error instanceof PeerBridgeError)) return void 0;
  switch (error.details.reason) {
    case "request-id-reuse":
      return "This answer request ID belongs to a different decision. Do not retry with changed answers.";
    case "ask-already-settled":
      return "The ask was already settled; this answer did not settle it.";
    case "stale-generation":
      return "The worker restarted; this ask is no longer answerable. Do not retry.";
    case "ask-expired":
      return "The ask expired (including after a worker restart) and is no longer answerable. Do not retry.";
    case "ask-not-found":
      return "The host no longer has this ask for the selected session. Read peer_asks before taking another action.";
    case "ask-store-unavailable":
      return "The host ask journal is unavailable; no answer was confirmed.";
    case "ask-write-failed":
      return "The host could not persist the answer; reuse the same request ID and decision if retrying.";
    default:
      return void 0;
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
  const headers = pairing.outboundToken === void 0 ? {} : { authorization: `Bearer ${pairing.outboundToken}` };
  return new PeerClient({
    endpoint: pairing.endpoint,
    device: config.device ?? device ?? pairing.peer,
    headers,
    ...config.maxReconnects === void 0 ? {} : { maxReconnects: config.maxReconnects },
    ...deps.fetch === void 0 ? {} : { fetch: deps.fetch },
    ...deps.webSocket === void 0 ? {} : { webSocket: deps.webSocket },
    ...deps.onWarning === void 0 ? {} : { onWarning: deps.onWarning },
    ...deps.onCompatibilityWarning === void 0 ? {} : { onCompatibilityWarning: deps.onCompatibilityWarning }
  });
}
function narrow(args) {
  return typeof args === "object" && args !== null ? args : {};
}
function capabilityGap(capabilities, capability) {
  if (capabilities.includes(capability)) return void 0;
  return { ok: false, error: { code: "peer/capability-missing", message: `host does not advertise ${capability}; upgrade the host` } };
}
function nonEmptyTextOf(name2, value) {
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "string" || value.trim() === "") return { ok: false, message: `${name2} must be a non-empty string` };
  return { ok: true, value: value.trim() };
}
function positiveIntegerOf(name2, value) {
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return { ok: false, message: `${name2} must be a positive integer` };
  return { ok: true, value };
}
function modelsFilterOf(request) {
  const filter = {};
  for (const name2 of ["zeroPrice", "tools"]) {
    const raw = request[name2];
    if (raw === void 0) continue;
    if (typeof raw !== "boolean") return { ok: false, message: `${name2} must be a boolean` };
    if (raw) filter[name2] = true;
  }
  return Object.keys(filter).length === 0 ? void 0 : { ok: true, value: filter };
}
function switchRouteOf(request) {
  const provider = nonEmptyTextOf("provider", request.provider);
  const model = nonEmptyTextOf("model", request.model);
  const chain = nonEmptyTextOf("chain", request.chain);
  const effort = nonEmptyTextOf("reasoningEffort", request.reasoningEffort);
  for (const parsed of [provider, model, chain, effort]) {
    if (parsed !== void 0 && !parsed.ok) return parsed;
  }
  const providerValue = provider?.ok === true ? provider.value : void 0;
  const modelValue = model?.ok === true ? model.value : void 0;
  const chainValue = chain?.ok === true ? chain.value : void 0;
  const effortValue = effort?.ok === true ? effort.value : void 0;
  if (providerValue === void 0 !== (modelValue === void 0)) {
    return { ok: false, message: "peer_switch_model needs provider and model together" };
  }
  if (providerValue === void 0 && chainValue === void 0) {
    return { ok: false, message: "peer_switch_model needs provider+model or a chain" };
  }
  if (effortValue !== void 0 && providerValue === void 0 && chainValue === void 0) {
    return { ok: false, message: "a reasoning effort needs a route or a chain to apply to" };
  }
  return {
    ok: true,
    value: {
      ...providerValue === void 0 ? {} : { provider: providerValue },
      ...modelValue === void 0 ? {} : { model: modelValue },
      ...chainValue === void 0 ? {} : { chain: chainValue },
      ...effortValue === void 0 ? {} : { reasoningEffort: effortValue }
    }
  };
}
function askCreateRoutingOf(request) {
  const provider = nonEmptyTextOf("provider", request.provider);
  const model = nonEmptyTextOf("model", request.model);
  const chain = nonEmptyTextOf("chain", request.chain);
  const effort = nonEmptyTextOf("reasoningEffort", request.reasoningEffort);
  const ceiling = positiveIntegerOf("maxTotalTokens", request.maxTotalTokens);
  for (const parsed of [provider, model, chain, effort, ceiling]) {
    if (parsed !== void 0 && !parsed.ok) return parsed;
  }
  const providerValue = provider?.ok === true ? provider.value : void 0;
  const modelValue = model?.ok === true ? model.value : void 0;
  const chainValue = chain?.ok === true ? chain.value : void 0;
  const effortValue = effort?.ok === true ? effort.value : void 0;
  const ceilingValue = ceiling?.ok === true ? ceiling.value : void 0;
  if (providerValue === void 0 !== (modelValue === void 0)) {
    return { ok: false, message: "peer_ask needs provider and model together" };
  }
  if (effortValue !== void 0 && providerValue === void 0 && chainValue === void 0) {
    return { ok: false, message: "a reasoning effort needs provider+model or a chain to apply to" };
  }
  return {
    ok: true,
    value: {
      ...providerValue === void 0 ? {} : { provider: providerValue },
      ...modelValue === void 0 ? {} : { model: modelValue },
      ...chainValue === void 0 ? {} : { chain: chainValue },
      ...effortValue === void 0 ? {} : { reasoningEffort: effortValue },
      ...ceilingValue === void 0 ? {} : { maxTotalTokens: ceilingValue }
    }
  };
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
    const reason = error.details.reason;
    const safeMessage = error.code === "peer/conflict" && reason === "request-id-reuse" ? "This request ID already belongs to a different payload. Reuse the original payload, or use a new ID for new work." : error.code === "peer/unavailable" && typeof reason === "string" && reason.startsWith("receipt-") ? reason === "receipt-write-failed" ? "The host could not persist the input receipt." : "The host receipt store could not confirm this request." : error.message;
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.code === "peer/target-unreachable" ? `REMOTE TARGET UNREACHABLE: ${error.endpoint}` : safeMessage,
        endpoint: error.endpoint,
        ...error.code === "peer/target-unreachable" ? { hint: "the peer device did not answer; the caller owns backoff" } : {}
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
function delay2(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
      since: { type: "number" },
      state: { type: "string" },
      settlementReason: { type: "string" },
      answeredBy: { type: "object", additionalProperties: false, properties: { requestId: { type: "string" }, payloadHash: { type: "string" } } }
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
    if (record.answerRequestId !== void 0) parts.push(`answer requestId=${record.answerRequestId}`);
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
    `peer ${String(record.alias)} \u2192 ${String(host.device ?? "")} @ ${String(record.endpoint)}${host.instanceId === void 0 ? "" : ` (instance ${String(host.instanceId)})`}`,
    `session ${String(record.sessionId)} (${String(record.exposure)}) bound=${String(record.bound)}`,
    `latch ${String(record.latch)} (${String(record.latchSource)}), descendants ${String(record.activeDescendants)}, model ${String(record.model)}`,
    ...record.stopIntent === void 0 ? [] : [stopIntentText(record.stopIntent)],
    pendingAsks.length === 0 ? "no pending asks" : `pending: ${pendingAsks.join("; ")}`
  ].join("\n");
}
function stopIntentSchema() {
  const keys = {
    requestedAt: "number",
    keepInbox: "boolean",
    turnState: "string",
    activeDescendants: "number",
    descendantsExact: "boolean",
    inFlightTools: "number",
    quiescence: "string"
  };
  return { type: "object", additionalProperties: false, properties: Object.fromEntries(Object.entries(keys).map(([key, type]) => [key, { type }])) };
}
function stopIntentText(value) {
  const stop = narrow(value);
  const tools = stop.inFlightTools === void 0 ? "" : `, in-flight tools ${String(stop.inFlightTools)}`;
  return `Stop ${stop.requestedAt === void 0 ? "not recorded" : "requested"}; inbox kept; turn ${String(stop.turnState)}, descendants ${String(stop.activeDescendants)} (exact=${String(stop.descendantsExact)})${tools}; quiescence ${stop.quiescence === "observed" ? "observed, not proof of teardown" : "unknown"}.`;
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
function routeFacts(model) {
  const known = (value) => value === true ? "yes" : value === "unknown" ? "unknown" : "no";
  const facts = [
    `tools=${known(model.tools)}`,
    `vision=${known(model.vision)}`,
    `free=${known(model.zeroPrice)}`,
    `gated=${known(model.gated)}`,
    `trains=${String(model.trainsOnData ?? "unknown")}`
  ];
  if (typeof model.contextWindow === "number") facts.push(`context=${String(model.contextWindow)}`);
  const efforts = Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts : [];
  if (efforts.length > 0) facts.push(`efforts=${efforts.join(",")}`);
  return facts.join(", ");
}
function listOrNone(value) {
  const items = Array.isArray(value) ? value.map((item) => String(item)) : [];
  return items.length === 0 ? "none" : items.join(", ");
}
function renderModels(value) {
  const record = narrow(value);
  if (record.ok !== true) {
    const error = narrow(record.error);
    return `peer_models failed [${String(error.code ?? "unknown")}]: ${String(error.message ?? "")}`;
  }
  const chains = Array.isArray(record.chains) ? record.chains : [];
  const models = Array.isArray(record.models) ? record.models : [];
  const lines = [`peer ${String(record.alias)} \u2014 ${String(models.length)} route(s), ${String(chains.length)} chain(s)`];
  for (const chain of chains) {
    const members = Array.isArray(chain.members) ? chain.members : [];
    const rendered = members.map((member) => {
      const until = member.state === "cooldown" && typeof member.cooldownUntil === "number" ? ` until ${new Date(member.cooldownUntil).toISOString()}` : "";
      return `${String(member.provider)}/${String(member.model)} ${String(member.state)}${until}`;
    });
    lines.push(`chain ${String(chain.id)}${chain.dynamic === true ? " (dynamic)" : ""}: ${rendered.join("; ")}`);
  }
  if (models.length === 0 && chains.length === 0) lines.push("no route is selectable on this peer");
  for (const model of models) lines.push(`\u2022 ${String(model.provider)}/${String(model.model)} \u2014 ${routeFacts(model)}`);
  const selectable = narrow(record.selectable);
  lines.push([
    `selectable: chains ${listOrNone(selectable.chains)}`,
    `models ${listOrNone(selectable.models)}`,
    `switching ${String(selectable.allowSwitch ?? "never")}`,
    selectable.requireZeroPrice === true ? "free routes only" : "",
    selectable.requireNoTraining === true ? "no-training routes only" : "",
    selectable.requireTools === true ? "tool-calling routes only" : ""
  ].filter((part) => part !== "").join(", "));
  if (typeof record.nextCursor === "string") {
    lines.push(`more routes available \u2014 call again with cursor ${JSON.stringify(record.nextCursor)}`);
  }
  return lines.join("\n");
}
function renderSwitch(value) {
  const record = narrow(value);
  if (record.ok !== true) {
    const error = narrow(record.error);
    return `peer_switch_model failed [${String(error.code ?? "unknown")}]: ${String(error.message ?? "")}`;
  }
  const selection = narrow(record.selection);
  const details = [
    selection.chain === void 0 ? void 0 : `chain ${String(selection.chain)}`,
    selection.reasoningEffort === void 0 ? void 0 : `effort ${String(selection.reasoningEffort)}`
  ].filter((part) => part !== void 0);
  const lines = [`switched ${String(record.alias)} to ${String(selection.provider)}/${String(selection.model)}${details.length === 0 ? "" : ` (${details.join(", ")})`}`];
  const previous = record.previous === void 0 ? void 0 : narrow(record.previous);
  if (previous !== void 0) {
    lines.push(`previous route ${String(previous.provider)}/${String(previous.model)}${previous.chain === void 0 ? "" : ` (chain ${String(previous.chain)})`}`);
  }
  if (record.replayed === true) lines.push("this exact switch was already applied; the session is unchanged");
  else if (typeof record.note === "string" && record.note !== "") lines.push(record.note);
  return lines.join("\n");
}
function renderAsk(value) {
  const record = narrow(value);
  if (record.disposition !== void 0 && (record.error !== void 0 || record.disposition === "cancelled_before_dispatch")) {
    const outcome = record.terminalState === void 0 ? "" : ` (${String(record.terminalState)})`;
    const create = record.createRequestId === void 0 ? "" : `; create requestId ${String(record.createRequestId)}`;
    const error = narrow(record.error);
    const detail = typeof error.message === "string" ? ` ${error.message}` : "";
    return `Remote input disposition: ${String(record.disposition)}${outcome} \u2014 requestId ${String(record.requestId)}${create}.${detail} No automatic resend.`;
  }
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
  if (record.status === "host_unreachable") {
    lines.push(`REMOTE TARGET WENT SILENT (unreachable) mid-turn on ${String(record.alias)} (session ${String(record.sessionId)}, latch ${String(record.latch ?? "unknown")}, cursor ${String(record.cursor ?? 0)}).`);
    lines.push(`It may be asleep; the remote turn was NOT cancelled and may resume if the host wakes \u2014 call peer_ask again with resume: ${JSON.stringify(String(record.requestId))} to re-follow.`);
    if (typeof record.answer === "string" && record.answer !== "") lines.push(record.answer);
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
  if (asks.length === 0) return record.instanceId === void 0 ? `no pending asks on ${String(record.alias)} (latch ${String(record.latch)})` : `no retained asks on ${String(record.alias)}`;
  return [
    `${String(asks.length)} ${record.instanceId === void 0 ? "pending" : "retained"} ask(s) on ${String(record.alias)}:`,
    ...asks.map((ask) => {
      if (ask.state !== void 0 && ask.state !== "pending") return `\u2022 ${String(ask.askId)} ${String(ask.kind)}: ${String(ask.state)}${ask.settlementReason === "host-restarted" ? " (worker restarted)" : ""} \u2014 not answerable`;
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
  const retry = typeof record.requestId === "string" ? ` (requestId ${record.requestId})` : "";
  if (record.ok === true) return `${record.settled === true ? "Answer settled" : "Answer not confirmed"} for ${String(record.askId)} on ${String(record.alias)} \u2014 ${String(record.note ?? "")}${retry}`;
  const error = narrow(record.error);
  const detail = typeof record.note === "string" && record.note !== "" ? record.note : String(error.message ?? "");
  return `peer_answer failed [${String(error.code ?? "unknown")}] ${String(record.askId ?? "")}: ${detail}${retry}`;
}
export {
  Config,
  apply,
  inject,
  name,
  registerTools
};
