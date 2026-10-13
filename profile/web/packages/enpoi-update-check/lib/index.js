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

// src/catalog.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
var CATALOG_SCHEMA_VERSION = 1;
var CATALOG_RAW_BASE_URL = "https://raw.githubusercontent.com/Darthph0enix7/Enpoi-harness/catalog";
var CATALOG_FETCH_TIMEOUT_MS = 15e3;
function catalogUrl(channel) {
  return `${CATALOG_RAW_BASE_URL}/${channel === "beta" ? "beta" : "stable"}.json`;
}
function compareVersions(left, right) {
  const leftTokens = versionTokens(left);
  const rightTokens = versionTokens(right);
  if (leftTokens === null || rightTokens === null) return null;
  const length = Math.max(leftTokens.length, rightTokens.length);
  for (let index = 0; index < length; index++) {
    const a = leftTokens[index];
    const b = rightTokens[index];
    if (a === void 0) return -1;
    if (b === void 0) return 1;
    if (typeof a === "number" && typeof b === "number") {
      if (a !== b) return a < b ? -1 : 1;
      continue;
    }
    if (typeof a === "string" && typeof b === "string") {
      if (a !== b) return a < b ? -1 : 1;
      continue;
    }
    return null;
  }
  return 0;
}
function versionTokens(version) {
  if (typeof version !== "string") return null;
  const text = version.trim().replace(/^v/i, "");
  if (text === "" || text.length > 128) return null;
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(text)) return null;
  const segments = text.split(/[.+_-]+/);
  if (!segments.some((segment) => /^[0-9]+$/.test(segment))) return null;
  return segments.map((segment) => /^[0-9]+$/.test(segment) ? Number(segment) : segment);
}
function isCatalogEntry(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value;
  if (typeof entry.version !== "string" || entry.version === "") return false;
  if (typeof entry.commit !== "string" || typeof entry.releasedAt !== "string") return false;
  if (!Array.isArray(entry.notes) || !entry.notes.every((note) => typeof note === "string")) return false;
  return true;
}
function parseCatalogDocument(value, channel) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const document = value;
  if (document.schemaVersion !== CATALOG_SCHEMA_VERSION) return null;
  if (document.channel !== channel) return null;
  if (!Array.isArray(document.releases)) return null;
  const releases = document.releases.filter(isCatalogEntry);
  return releases.length === 0 ? null : releases;
}
async function fetchCatalog(channel, fetchImpl = fetch) {
  const response = await fetchImpl(catalogUrl(channel), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`catalog fetch failed: HTTP ${response.status}`);
  const text = await response.text();
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error("catalog fetch failed: invalid JSON");
  }
  const entries = parseCatalogDocument(document, channel);
  if (entries === null) throw new Error("catalog fetch failed: malformed document");
  return entries;
}
function readPackageVersion(file) {
  try {
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    return typeof manifest.version === "string" && manifest.version !== "" ? manifest.version : null;
  } catch {
    return null;
  }
}
function readInstallIdentity(homeDir) {
  let state = {};
  try {
    state = JSON.parse(readFileSync(join(homeDir, "harness", "install-state.json"), "utf8"));
  } catch {
    state = {};
  }
  const channel = state.channel === "beta" ? "beta" : "stable";
  const recorded = typeof state.version === "string" && state.version !== "" ? state.version : null;
  const prefix = typeof state.prefix === "string" && state.prefix !== "" ? state.prefix : homeDir;
  const version = recorded ?? readPackageVersion(join(prefix, "harness", "current", "package.json")) ?? readPackageVersion(join(homeDir, "harness", "current", "package.json")) ?? "";
  return {
    channel,
    version,
    commit: typeof state.commit === "string" ? state.commit : ""
  };
}

// src/remote.ts
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

// src/run-service.ts
import { existsSync, readFileSync as readFileSync3, rmSync, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join3 } from "node:path";
import { randomUUID } from "node:crypto";

// src/launcher.ts
import { spawn as nodeSpawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join as join2 } from "node:path";
import { homedir } from "node:os";
var LAUNCH_WRAPPER = 'log="$1"; pid="$2"; shift 2; echo $$ > "$pid"; exec "$@" >>"$log" 2>&1';
var RUN_HOME_ENV = "DSH_HOME";
function commandOnPath(command, pathSpec = process.env.PATH) {
  if (pathSpec === void 0 || pathSpec === "") return false;
  for (const dir of pathSpec.split(delimiter)) {
    if (dir === "") continue;
    if (directoryHasExecutable(join2(dir, command))) return true;
  }
  return false;
}
function directoryHasExecutable(file) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function wrapperArgs(input) {
  return [
    "-c",
    LAUNCH_WRAPPER,
    "dsh-update",
    input.logPath,
    input.pidFile,
    input.shim,
    "update",
    "--channel",
    input.channel
  ];
}
function launchPlan(input) {
  const platform = input.platform ?? process.platform;
  const has = input.hasCommand ?? ((command) => commandOnPath(command));
  const args = wrapperArgs(input);
  const steps = [];
  if (platform === "linux" && has("systemd-run")) {
    const runtimeDir = process.env.XDG_RUNTIME_DIR ?? `/run/user/${String(input.uid ?? process.getuid?.() ?? 0)}`;
    steps.push({
      rung: "systemd-run",
      command: "systemd-run",
      unit: `dsh-update-${input.runId}`,
      args: [
        "--user",
        "--collect",
        "--quiet",
        "--wait",
        `--unit=dsh-update-${input.runId}`,
        `--setenv=XDG_RUNTIME_DIR=${runtimeDir}`,
        `--setenv=${RUN_HOME_ENV}=${input.home}`,
        "--",
        "sh",
        ...args
      ]
    });
  }
  if (platform === "darwin" && has("launchctl")) {
    steps.push({
      rung: "launchctl",
      command: "launchctl",
      unit: `com.dsh.update.${input.runId}`,
      args: [
        "submit",
        "-l",
        `com.dsh.update.${input.runId}`,
        "-o",
        input.logPath,
        "-e",
        input.logPath,
        "--",
        "sh",
        ...args
      ]
    });
  }
  if (has("setsid")) {
    steps.push({ rung: "setsid", command: "setsid", args: ["sh", ...args] });
  }
  steps.push({ rung: "spawn", command: "sh", args });
  return steps;
}
function launchUpdater(input) {
  const spawn = input.spawn ?? ((command, args, options) => nodeSpawn(command, [...args], options));
  const plan = launchPlan(input);
  let lastError;
  for (const step of plan) {
    try {
      const child = spawn(step.command, step.args, {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, [RUN_HOME_ENV]: input.home }
      });
      child.unref?.();
      return {
        rung: step.rung,
        ...step.unit === void 0 ? {} : { unit: step.unit },
        pid: typeof child.pid === "number" ? child.pid : null
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("no launch rung could start the updater");
}
function defaultShimPath() {
  return join2(homedir(), ".local", "bin", "dsh");
}

// src/run.ts
import { mkdirSync, readFileSync as readFileSync2, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
var RUN_STEP_TOTAL = 9;
var STEP_PHASES = [
  "fetch",
  "fetch",
  "verify",
  "unpack",
  "deps",
  "profile",
  "profile",
  "switch",
  "selfcheck"
];
function phaseForResult(result) {
  return result === "success" ? "done" : result;
}
function phaseForStep(step) {
  if (!Number.isFinite(step) || step < 1) return "starting";
  return STEP_PHASES[Math.min(Math.trunc(step), RUN_STEP_TOTAL) - 1] ?? "fetch";
}
var LOG_TAIL_LINES = 40;
var LOG_TAIL_BYTES = 64 * 1024;
var STEP_MARKER = /\[(\d+)\/(\d+)\]/;
var ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
function plain(line) {
  return line.replace(ANSI, "").replace(/\r/g, "").trimEnd();
}
function resultFromLine(line) {
  if (/rolled back/i.test(line)) return "rolledback";
  if (/successfully updated|already up to date/i.test(line)) return "success";
  if (/\bFAILED\b|✗\s*ERROR:/.test(line)) return "failed";
  return null;
}
function parseRunLog(text) {
  const lines = text.split("\n").map(plain).filter((line) => line.trim() !== "");
  let step = 0;
  let steps = RUN_STEP_TOTAL;
  let result = null;
  for (const line of lines) {
    const marker = STEP_MARKER.exec(line);
    if (marker !== null) {
      const seen = Number(marker[1]);
      if (Number.isFinite(seen) && seen > step) step = seen;
      const total = Number(marker[2]);
      if (Number.isFinite(total) && total > 0) steps = total;
    }
    result = resultFromLine(line) ?? result;
  }
  const logTail = lines.slice(-LOG_TAIL_LINES);
  const lastLine = lines.at(-1) ?? "";
  return {
    step,
    steps,
    lastLine,
    logTail,
    phase: result === null ? phaseForStep(step) : phaseForResult(result),
    result
  };
}
function readRunLog(logPath, maxBytes = LOG_TAIL_BYTES) {
  let text = "";
  try {
    const size = statSync(logPath).size;
    const start = Math.max(0, size - maxBytes);
    const descriptor = readFileSync2(logPath);
    text = descriptor.subarray(start).toString("utf8");
  } catch {
    text = "";
  }
  return parseRunLog(text);
}
function updateCheckDir(home) {
  return `${home}/update-check`;
}
function runRecordPath(home) {
  return `${updateCheckDir(home)}/run.json`;
}
function runLogPath(home) {
  return `${updateCheckDir(home)}/run.log`;
}
function runPidPath(home) {
  return `${updateCheckDir(home)}/run.pid`;
}
function isRunRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value;
  return typeof record.runId === "string" && typeof record.target === "string" && typeof record.phase === "string" && typeof record.startedAt === "string" && typeof record.logPath === "string" && (record.result === null || record.result === "success" || record.result === "failed" || record.result === "rolledback");
}
function readRunRecord(file) {
  try {
    const parsed = JSON.parse(readFileSync2(file, "utf8"));
    return isRunRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function writeRunRecord(file, record) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.tmp.${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}
`);
    renameSync(temporary, file);
    return true;
  } catch {
    return false;
  }
}
function readRunPid(file) {
  try {
    const pid = Number.parseInt(readFileSync2(file, "utf8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function effectivePid(home, record) {
  const pid = readRunPid(runPidPath(home));
  return pid ?? record.pid;
}
function isRunActive(home, record) {
  if (record.result !== null) return false;
  const pid = effectivePid(home, record);
  return pid !== null && isProcessAlive(pid);
}
function reconcileRunRecord(record, identity, now = () => /* @__PURE__ */ new Date(), home) {
  if (record.result !== null) return { record, changed: false };
  if (home !== void 0 && isRunActive(home, record)) return { record, changed: false };
  if (home === void 0) {
    const pid = record.pid;
    if (pid !== null && isProcessAlive(pid)) return { record, changed: false };
  }
  const finishedAt = now().toISOString();
  if (identity.version !== "" && identity.version === record.target) {
    return {
      record: { ...record, phase: "done", result: "success", finishedAt },
      changed: true
    };
  }
  const version = identity.version === "" ? "unknown" : identity.version;
  return {
    record: {
      ...record,
      phase: "failed",
      result: "failed",
      finishedAt,
      reason: `updater is no longer running and the install version (${version}) does not match the target (${record.target})`
    },
    changed: true
  };
}
function sameRunRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function targetReached(installed, target) {
  const comparison = compareVersions(installed, target);
  return comparison === null ? null : comparison >= 0;
}

// src/run-service.ts
var RunRefusedError = class extends Error {
  /** Structured refusal reason. */
  reason;
  /**
   * @param reason - structured refusal reason.
   * @param message - human-readable reason (surfaced to the operator).
   */
  constructor(reason, message) {
    super(message);
    this.name = "RunRefusedError";
    this.reason = reason;
  }
};
var RUN_START_GRACE_MS = 15e3;
function resolveShimPath(home) {
  let binDir = "";
  try {
    const state = JSON.parse(
      readFileSync3(join3(home, "harness", "install-state.json"), "utf8")
    );
    binDir = typeof state.binDir === "string" ? state.binDir : "";
  } catch {
    binDir = "";
  }
  const candidates = [...binDir === "" ? [] : [join3(binDir, "dsh")], defaultShimPath()];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}
var UpdateRunController = class {
  options;
  now;
  record = null;
  loaded = false;
  watcher = null;
  timers;
  /**
   * @param options - home, identity/status readers, launch and timer seams.
   */
  constructor(options) {
    this.options = options;
    this.now = options.now ?? (() => /* @__PURE__ */ new Date());
    this.timers = options.timers ?? {
      setInterval: (handler, delayMs) => setInterval(handler, delayMs),
      clearInterval: (handle) => clearInterval(handle)
    };
  }
  /** The current record (from memory, or the persisted state on first read). */
  run() {
    if (!this.loaded) {
      this.loaded = true;
      this.record = readRunRecord(runRecordPath(this.options.home));
    }
    return this.record;
  }
  /**
   * Boot reconcile: resolve a record left by a dead watcher. Idempotent.
   * @returns the reconciled record, or null when none exists.
   */
  reconcile() {
    const current = this.run();
    if (current === null) return null;
    if (current.result === null && this.isAliveRecord(current)) {
      this.watch(current);
      return current;
    }
    const { record, changed } = reconcileRunRecord(
      current,
      this.options.readIdentity(),
      this.now,
      this.options.isAlive === void 0 ? this.options.home : void 0
    );
    if (changed) this.persist(record);
    return record;
  }
  /**
   * Start one update run.
   *
   * @returns the freshly persisted record (phase `starting`).
   * @throws RunRefusedError when no update is available, a run is active, the
   *   shim is missing, or the launch rung fails.
   */
  start() {
    this.reconcile();
    const status = this.options.readStatus();
    if (status.state !== "available" || status.latest === void 0) {
      throw new RunRefusedError(
        "not-available",
        `updateCheck.start: no update is available (state=${status.state})`
      );
    }
    const active = this.run();
    if (active !== null && active.result === null && this.isAliveRecord(active)) {
      throw new RunRefusedError(
        "already-running",
        `updateCheck.start: an update is already running (run ${active.runId}, step ${String(active.step)}/${String(active.steps)})`
      );
    }
    const shim = (this.options.resolveShim ?? resolveShimPath)(this.options.home);
    if (shim === null) {
      throw new RunRefusedError(
        "shim-missing",
        `updateCheck.start: the dsh shim was not found (checked the recorded binDir and ${defaultShimPath()})`
      );
    }
    const runId = (this.options.runId ?? (() => randomUUID().replace(/-/g, "").slice(0, 10)))();
    const home = this.options.home;
    const logPath = runLogPath(home);
    const pidFile = runPidPath(home);
    const base = {
      runId,
      target: status.latest.version,
      channel: status.current.channel,
      phase: "starting",
      step: 0,
      steps: RUN_STEP_TOTAL,
      lastLine: "",
      startedAt: this.now().toISOString(),
      pid: null,
      logPath,
      result: null,
      rung: "pending",
      logTail: []
    };
    try {
      writeFileSync2(logPath, "");
      rmSync(pidFile, { force: true });
    } catch {
    }
    this.record = base;
    this.loaded = true;
    this.persist(base);
    this.launch(base, shim);
    return this.run() ?? base;
  }
  /** Stop the watcher (plugin unload). The updater itself keeps running. */
  dispose() {
    this.stopWatcher();
  }
  /** Launch through the ladder, persist the outcome, and start watching. */
  launch(record, shim) {
    const home = this.options.home;
    let outcome;
    try {
      outcome = (this.options.launch ?? launchUpdater)({
        home,
        shim,
        channel: record.channel,
        runId: record.runId,
        logPath: record.logPath,
        pidFile: runPidPath(home),
        ...this.options.platform === void 0 ? {} : { platform: this.options.platform },
        ...this.options.hasCommand === void 0 ? {} : { hasCommand: this.options.hasCommand },
        ...this.options.uid === void 0 ? {} : { uid: this.options.uid }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = {
        ...record,
        phase: "failed",
        result: "failed",
        finishedAt: this.now().toISOString(),
        reason: `could not launch the updater: ${message}`
      };
      this.persist(failed);
      throw new RunRefusedError("launch-failed", `updateCheck.start: could not launch the updater: ${message}`);
    }
    const started = {
      ...record,
      rung: outcome.rung,
      pid: outcome.pid
    };
    this.persist(started);
    this.watch(started);
  }
  /** Resume/replace the watcher for one record. */
  watch(record) {
    this.stopWatcher();
    this.record = record;
    this.loaded = true;
    const handle = this.timers.setInterval(() => {
      this.tick();
    }, this.options.pollIntervalMs ?? 1e3);
    handle.unref?.();
    this.watcher = handle;
    this.tick();
  }
  stopWatcher() {
    if (this.watcher !== null) {
      this.timers.clearInterval(this.watcher);
      this.watcher = null;
    }
  }
  /** One watcher tick: refresh progress from the log tail and judge liveness. */
  tick() {
    const record = this.record;
    if (record === null || record.result !== null) {
      if (record !== null && !this.isAliveRecord(record)) this.stopWatcher();
      return;
    }
    const parsed = readRunLog(record.logPath);
    const wrapperPid = readRunPid(runPidPath(this.options.home));
    const pid = wrapperPid ?? record.pid;
    const alive = pid !== null && (this.options.isAlive ?? isProcessAlive)(pid);
    const startedAtMs = Date.parse(record.startedAt);
    const withinGrace = wrapperPid === null && Number.isFinite(startedAtMs) && this.now().getTime() - startedAtMs < RUN_START_GRACE_MS;
    let next = {
      ...record,
      step: parsed.step > 0 ? parsed.step : record.step,
      steps: parsed.steps,
      lastLine: parsed.lastLine === "" ? record.lastLine : parsed.lastLine,
      phase: parsed.step > 0 ? parsed.phase : record.phase,
      logTail: parsed.logTail,
      pid
    };
    if (parsed.result !== null) {
      next = {
        ...next,
        result: parsed.result,
        phase: phaseForResult(parsed.result),
        finishedAt: this.now().toISOString(),
        ...parsed.result === "success" ? {} : { reason: parsed.lastLine }
      };
      this.persist(next);
      if (!alive) this.stopWatcher();
      return;
    }
    if (!alive && !withinGrace) {
      next = {
        ...next,
        phase: "failed",
        result: "failed",
        finishedAt: this.now().toISOString(),
        reason: parsed.lastLine === "" ? "the updater exited before writing any output" : `the updater exited before reporting a result (last line: ${parsed.lastLine})`
      };
      this.persist(next);
      this.stopWatcher();
      return;
    }
    this.persist(next);
  }
  /** Persist when changed and publish to the plugin. */
  persist(record) {
    const previous = this.record;
    this.record = record;
    if (previous === null || !sameRunRecord(previous, record)) {
      writeRunRecord(runRecordPath(this.options.home), record);
      this.options.onUpdate?.(record);
    }
  }
  /** Whether a record has a live process by the controller's liveness seam. */
  isAliveRecord(record) {
    if (this.options.isAlive === void 0) return isRunActive(this.options.home, record);
    const pid = effectivePid(this.options.home, record);
    return pid !== null && this.options.isAlive(pid);
  }
};

// src/remote.ts
var UPDATE_CHECK_NAMESPACE = "updateCheck";
var _run_dec, _start_dec, _dismiss_dec, _checkNow_dec, _status_dec, _a, _init;
var UpdateCheckService = class extends (_a = TypertRemoteService, _status_dec = [Remote], _checkNow_dec = [Remote], _dismiss_dec = [Remote], _start_dec = [Remote], _run_dec = [Remote], _a) {
  /**
   * @param ctx - owning context (service registration is automatic).
   * @param options - the core that owns the status and the run controller.
   */
  constructor(ctx, options) {
    super(ctx, UPDATE_CHECK_NAMESPACE);
    __runInitializers(_init, 5, this);
    __publicField(this, "core");
    __publicField(this, "runs");
    this.core = options.core;
    this.runs = options.runs;
  }
  status() {
    return this.core.snapshot();
  }
  checkNow() {
    return this.core.checkNow();
  }
  dismiss(request) {
    const version = typeof request?.version === "string" ? request.version.trim() : "";
    if (version === "") {
      throw new RemoteError("gateway/bad-request", "updateCheck.dismiss: version is required", {});
    }
    return this.core.dismiss(version);
  }
  start() {
    try {
      return this.runs.start();
    } catch (error) {
      if (error instanceof RunRefusedError) {
        throw new RemoteError("gateway/bad-request", error.message, {});
      }
      throw error;
    }
  }
  run() {
    return this.runs.run();
  }
};
_init = __decoratorStart(_a);
__decorateElement(_init, 1, "status", _status_dec, UpdateCheckService);
__decorateElement(_init, 1, "checkNow", _checkNow_dec, UpdateCheckService);
__decorateElement(_init, 1, "dismiss", _dismiss_dec, UpdateCheckService);
__decorateElement(_init, 1, "start", _start_dec, UpdateCheckService);
__decorateElement(_init, 1, "run", _run_dec, UpdateCheckService);
__decoratorMetadata(_init, UpdateCheckService);
/** Nothing is injected into the service fiber; the plugin passes the core. */
__publicField(UpdateCheckService, "inject", []);

// src/service.ts
function errorText(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
function cloneNotes(notes) {
  return [...notes];
}
var UpdateCheckCore = class {
  options;
  now;
  status;
  inFlight = null;
  /**
   * @param options - identity, fetch, dismissal store, and clock.
   */
  constructor(options) {
    this.options = options;
    this.now = options.now ?? (() => /* @__PURE__ */ new Date());
    this.status = { state: "unknown", current: { ...options.identity } };
  }
  /** The current status; a fresh object each call. */
  snapshot() {
    return this.copy(this.status);
  }
  /**
   * Run one check. Never rejects: a transport, response, or catalog failure
   * resolves to the preserved state plus `error`.
   *
   * @returns the status after the attempt.
   */
  checkNow() {
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.runCheck().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }
  /**
   * Persist `version` as dismissed. When that version is the one currently
   * offered, the state becomes `dismissed` immediately.
   *
   * @param version - release version to skip.
   * @returns the status after recording the skip.
   */
  dismiss(version) {
    this.options.writeDismissed(version);
    if (this.status.state === "available" && this.status.latest?.version === version) {
      this.status = { ...this.status, state: "dismissed" };
    }
    return this.snapshot();
  }
  async runCheck() {
    const checkedAt = this.now().toISOString();
    try {
      const entries = await this.options.fetchCatalog(this.options.identity.channel);
      const newest = entries[0];
      if (newest === void 0) {
        return this.fail(checkedAt, "catalog carries no releases");
      }
      const comparison = compareVersions(this.options.identity.version, newest.version);
      if (comparison === null) {
        return this.fail(
          checkedAt,
          `uncomparable versions: ${JSON.stringify(this.options.identity.version)} vs ${JSON.stringify(newest.version)}`
        );
      }
      const dismissed = this.options.readDismissed();
      const state = comparison >= 0 ? "current" : dismissed === newest.version ? "dismissed" : "available";
      this.status = {
        state,
        current: { ...this.options.identity },
        latest: {
          version: newest.version,
          commit: newest.commit,
          releasedAt: newest.releasedAt,
          notes: cloneNotes(newest.notes)
        },
        checkedAt
      };
      return this.snapshot();
    } catch (error) {
      return this.fail(checkedAt, errorText(error));
    }
  }
  /** Record one failed attempt: keep the last comparison, set `error`, notify once. */
  fail(checkedAt, error) {
    this.options.onFailure?.(error);
    this.status = { ...this.status, checkedAt, error };
    return this.snapshot();
  }
  copy(status) {
    return {
      state: status.state,
      current: { ...status.current },
      ...status.latest === void 0 ? {} : { latest: { ...status.latest, notes: cloneNotes(status.latest.notes) } },
      ...status.checkedAt === void 0 ? {} : { checkedAt: status.checkedAt },
      ...status.error === void 0 ? {} : { error: status.error }
    };
  }
};
var FIRST_CHECK_DELAY_MS = 3e4;
function jitteredDelay(baseMs, jitterMs, random = Math.random) {
  return baseMs + Math.floor(random() * Math.max(0, jitterMs));
}
function startUpdateCheckSchedule(options) {
  const timers = options.timers ?? {
    setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
    clearTimeout: (handle2) => clearTimeout(handle2)
  };
  const random = options.random ?? Math.random;
  let disposed = false;
  let handle = null;
  const schedule = (delayMs) => {
    if (disposed) return;
    handle = timers.setTimeout(() => {
      if (disposed) return;
      void options.run();
      schedule(jitteredDelay(options.intervalMs, options.jitterMs, random));
    }, delayMs);
    handle.unref?.();
  };
  schedule(jitteredDelay(options.firstDelayMs ?? FIRST_CHECK_DELAY_MS, options.jitterMs, random));
  return () => {
    disposed = true;
    if (handle !== null) timers.clearTimeout(handle);
  };
}

// src/store.ts
import { mkdirSync as mkdirSync2, readFileSync as readFileSync4, renameSync as renameSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname2 } from "node:path";
function readDismissedVersion(file) {
  try {
    const record = JSON.parse(readFileSync4(file, "utf8"));
    return typeof record.version === "string" && record.version !== "" ? record.version : null;
  } catch {
    return null;
  }
}
function writeDismissedVersion(file, version, now = () => /* @__PURE__ */ new Date()) {
  try {
    mkdirSync2(dirname2(file), { recursive: true });
    const temporary = `${file}.tmp.${process.pid}`;
    writeFileSync3(temporary, `${JSON.stringify({ version, at: now().toISOString() }, null, 2)}
`);
    renameSync2(temporary, file);
    return true;
  } catch {
    return false;
  }
}

// src/index.ts
var name = "enpoi-update-check";
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
  enabled: live(Schema.boolean().default(true)),
  intervalMinutes: live(Schema.number().default(360)),
  jitterSeconds: live(Schema.number().default(300))
});
function clamp(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.trunc(numeric), min), max);
}
function errorText2(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
function apply(ctx, config = {}) {
  config = plainConfig(config);
  try {
    const homeResolver = ctx.get("dshHomePath");
    const resolveHome = typeof homeResolver === "function" ? homeResolver : dshHomePath;
    const home = resolveHome();
    const identity = readInstallIdentity(home);
    const dismissedPath = resolveHome("update-check", "dismissed.json");
    const intervalMinutes = clamp(config.intervalMinutes, 1, 10080, 360);
    const jitterSeconds = clamp(config.jitterSeconds, 0, 3600, 300);
    const core = new UpdateCheckCore({
      identity,
      fetchCatalog: (channel) => fetchCatalog(channel),
      readDismissed: () => readDismissedVersion(dismissedPath),
      writeDismissed: (version) => {
        writeDismissedVersion(dismissedPath, version);
      },
      onFailure: (message) => {
        ctx.logger.debug(`enpoi-update-check: ${message}`);
      }
    });
    const runs = new UpdateRunController({
      home,
      readIdentity: () => readInstallIdentity(home),
      readStatus: () => core.snapshot(),
      onUpdate: (record) => {
        ctx.logger.debug(`enpoi-update-check: run ${record.runId} phase=${record.phase} step=${String(record.step)}/${String(record.steps)}${record.result === null ? "" : ` result=${record.result}`}`);
      }
    });
    ctx.effect(() => () => {
      runs.dispose();
    }, "enpoi-update-check.run-watcher");
    try {
      const reconciled = runs.reconcile();
      if (reconciled !== null) {
        ctx.logger.info(`enpoi-update-check: reconciled run ${reconciled.runId} (phase=${reconciled.phase}${reconciled.result === null ? "" : ` result=${reconciled.result}`})`);
      }
    } catch (error) {
      ctx.logger.debug(`enpoi-update-check: run reconcile failed \u2014 ${errorText2(error)}`);
    }
    ctx.plugin(UpdateCheckService, { core, runs });
    if (config.enabled !== false) {
      const stop = startUpdateCheckSchedule({
        run: () => {
          void core.checkNow();
        },
        intervalMs: intervalMinutes * 6e4,
        jitterMs: jitterSeconds * 1e3
      });
      ctx.effect(() => stop, "enpoi-update-check.schedule");
    }
    const mounted = `enpoi-update-check mounted (home=${home} channel=${identity.channel} version=${identity.version === "" ? "unknown" : identity.version} interval=${intervalMinutes}m checks=${config.enabled === false ? "off" : "on"})`;
    process.stderr.write(`[enpoi-update-check] ${mounted}
`);
    ctx.logger.info(`enpoi-update-check: ${mounted}`);
  } catch (error) {
    process.stderr.write(`[enpoi-update-check] disabled \u2014 ${errorText2(error)}
`);
  }
}
export {
  CATALOG_FETCH_TIMEOUT_MS,
  CATALOG_RAW_BASE_URL,
  CATALOG_SCHEMA_VERSION,
  Config,
  FIRST_CHECK_DELAY_MS,
  LAUNCH_WRAPPER,
  LOG_TAIL_BYTES,
  LOG_TAIL_LINES,
  RUN_HOME_ENV,
  RUN_START_GRACE_MS,
  RUN_STEP_TOTAL,
  RunRefusedError,
  STEP_PHASES,
  UPDATE_CHECK_NAMESPACE,
  UpdateCheckCore,
  UpdateCheckService,
  UpdateRunController,
  apply,
  catalogUrl,
  commandOnPath,
  compareVersions,
  defaultShimPath,
  effectivePid,
  fetchCatalog,
  inject,
  isProcessAlive,
  isRunActive,
  jitteredDelay,
  launchPlan,
  launchUpdater,
  name,
  parseCatalogDocument,
  parseRunLog,
  phaseForResult,
  phaseForStep,
  readDismissedVersion,
  readInstallIdentity,
  readRunLog,
  readRunPid,
  readRunRecord,
  reconcileRunRecord,
  resolveShimPath,
  resultFromLine,
  runLogPath,
  runPidPath,
  runRecordPath,
  sameRunRecord,
  startUpdateCheckSchedule,
  targetReached,
  updateCheckDir,
  wrapperArgs,
  writeDismissedVersion,
  writeRunRecord
};
