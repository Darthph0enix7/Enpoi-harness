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
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync4, rmSync, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname2, join as join5 } from "node:path";
import { randomUUID } from "node:crypto";

// src/launcher.ts
import { spawn as nodeSpawn } from "node:child_process";
import { accessSync, constants, readdirSync } from "node:fs";
import { delimiter, join as join2 } from "node:path";
import { homedir } from "node:os";
var RUN_HOME_ENV = "DSH_HOME";
var UPDATE_MODE_ENV = "DSH_UPDATE_MODE";
var LaunchEnvironmentError = class extends Error {
  /** Every location the probe consulted, in order. */
  probed;
  /**
   * @param probed - every location the probe consulted, in order.
   */
  constructor(probed) {
    super(
      `no Node.js runtime found for the updater (probed: ${probed.join(", ")}). Install Node 22.19+ or record the install prefix so $PREFIX/runtime/node/current resolves.`
    );
    this.name = "LaunchEnvironmentError";
    this.probed = probed;
  }
};
function systemBinDirs(platform = process.platform) {
  return platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] : ["/usr/local/bin", "/usr/bin", "/bin"];
}
function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function commandOnPath(command, pathSpec) {
  if (pathSpec === void 0 || pathSpec === "") return false;
  for (const dir of pathSpec.split(delimiter)) {
    if (dir === "") continue;
    if (isExecutable(join2(dir, command))) return true;
  }
  return false;
}
function newestVersionDir(parent) {
  let names;
  try {
    names = readdirSync(parent).filter((name2) => /^v?\d/.test(name2));
  } catch {
    return void 0;
  }
  if (names.length === 0) return void 0;
  const weight = (name2) => name2.replace(/^v/, "").split(/[^0-9]+/).filter((part) => part !== "").map(Number);
  names.sort((left, right) => {
    const a = weight(left);
    const b = weight(right);
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      const diff = (a[index] ?? 0) - (b[index] ?? 0);
      if (diff !== 0) return diff;
    }
    return left.localeCompare(right);
  });
  return names.at(-1);
}
function resolveRuntime(input) {
  const platform = input.platform ?? process.platform;
  const baseEnv = input.baseEnv ?? process.env;
  const probed = [];
  const prefixRuntime = join2(input.prefix, "runtime", "node", "current", "bin");
  probed.push(prefixRuntime);
  if (isExecutable(join2(prefixRuntime, "node"))) {
    return { probe: { binDir: prefixRuntime, source: "prefix-runtime" }, probed };
  }
  for (const root of [
    join2(input.homeDir, ".local", "share", "nvm"),
    join2(input.homeDir, ".nvm", "versions", "node")
  ]) {
    const newest = newestVersionDir(root);
    if (newest === void 0) {
      probed.push(`${root}/*/bin`);
      continue;
    }
    const binDir = join2(root, newest, "bin");
    probed.push(binDir);
    if (isExecutable(join2(binDir, "node"))) {
      return { probe: { binDir, source: "nvm" }, probed };
    }
  }
  if (commandOnPath("node", baseEnv.PATH)) {
    return { probe: { binDir: "", source: "path" }, probed };
  }
  probed.push("PATH");
  for (const dir of systemBinDirs(platform)) {
    probed.push(dir);
    if (isExecutable(join2(dir, "node"))) {
      return { probe: { binDir: dir, source: "system" }, probed };
    }
  }
  return { probe: null, probed };
}
function resolveRuntimePath(input) {
  const baseEnv = input.baseEnv ?? process.env;
  const { probe, probed } = resolveRuntime(input);
  if (probe === null) return { path: null, probe: null, probed };
  const segments = [probe.binDir, baseEnv.PATH ?? "", ...systemBinDirs(input.platform)].flatMap((value) => value.split(delimiter)).filter((segment) => segment !== "");
  return { path: [...new Set(segments)].join(delimiter), probe, probed };
}
function resolveLaunchEnvironment(input) {
  const baseEnv = input.baseEnv ?? process.env;
  const resolved = resolveRuntimePath({
    prefix: input.prefix,
    homeDir: input.probeHomeDir ?? homedir(),
    ...input.baseEnv === void 0 ? {} : { baseEnv: input.baseEnv },
    ...input.platform === void 0 ? {} : { platform: input.platform }
  });
  if (resolved.path === null || resolved.probe === null) throw new LaunchEnvironmentError(resolved.probed);
  const env = {
    ...baseEnv,
    PATH: resolved.path,
    [RUN_HOME_ENV]: input.home,
    ...input.prefix === "" ? {} : { PREFIX: input.prefix },
    // The engine labels its run marker from this hook; a one-shot rung has no
    // phase flag, so without it the marker would read `plain`.
    ...input.flag === "one-shot" ? { [UPDATE_MODE_ENV]: "one-shot" } : {}
  };
  return {
    nodePath: resolved.probe.binDir === "" ? null : join2(resolved.probe.binDir, "node"),
    source: resolved.probe.source,
    path: resolved.path,
    env,
    probed: resolved.probed
  };
}
function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function launchWrapper(environment) {
  const parts = [
    'log="$1"',
    'pid="$2"',
    "shift 2",
    `export PATH=${shellQuote(environment.path)}`,
    `export ${RUN_HOME_ENV}=${shellQuote(environment.env[RUN_HOME_ENV] ?? "")}`
  ];
  const prefix = environment.env.PREFIX;
  if (prefix !== void 0 && prefix !== "") parts.push(`export PREFIX=${shellQuote(prefix)}`);
  parts.push('echo $$ > "$pid"', 'exec "$@" >>"$log" 2>&1');
  return parts.join("; ");
}
function wrapperArgs(input, environment) {
  const engineArgs = input.flag === "--apply" ? ["--apply"] : ["--channel", input.channel ?? "stable", ...input.flag === "--prepare" ? ["--prepare"] : []];
  return [
    "-c",
    launchWrapper(environment),
    "dsh-update",
    input.logPath,
    input.pidFile,
    input.shim,
    "update",
    ...engineArgs
  ];
}
function launchPlan(input, environment) {
  const platform = input.platform ?? process.platform;
  const has = input.hasCommand ?? ((command) => commandOnPath(command, process.env.PATH));
  const args = wrapperArgs(input, environment);
  const envArgs = [
    `--setenv=PATH=${environment.path}`,
    `--setenv=${RUN_HOME_ENV}=${input.home}`,
    ...input.prefix === "" ? [] : [`--setenv=PREFIX=${input.prefix}`],
    ...input.flag === "one-shot" ? [`--setenv=${UPDATE_MODE_ENV}=one-shot`] : []
  ];
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
        ...envArgs,
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
  const environment = resolveLaunchEnvironment(input);
  const spawn3 = input.spawn ?? ((command, args, options) => nodeSpawn(command, [...args], options));
  const plan = launchPlan(input, environment);
  let lastError;
  for (const step of plan) {
    try {
      const child = spawn3(step.command, step.args, {
        detached: true,
        stdio: "ignore",
        env: environment.env
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

// src/cancel.ts
import { spawn } from "node:child_process";
var CANCEL_TIMEOUT_MS = 3e4;
var CANCEL_OUTPUT_CAP = 64 * 1024;
function parseCancelJson(stdout) {
  for (const line of stdout.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const raw = parsed;
    if (raw.action !== "cancel") continue;
    const status = raw.status === "cancelled" || raw.status === "refused" || raw.status === "noop" ? raw.status : "failed";
    const pidRaw = typeof raw.pid === "string" ? Number.parseInt(raw.pid, 10) : raw.pid;
    return {
      status,
      runId: typeof raw.runId === "string" ? raw.runId : "",
      pid: typeof pidRaw === "number" && Number.isFinite(pidRaw) && pidRaw > 0 ? Math.trunc(pidRaw) : null,
      phase: typeof raw.phase === "string" ? raw.phase : ""
    };
  }
  return null;
}
function cancelEngineRun(input) {
  const timeoutMs = input.timeoutMs ?? CANCEL_TIMEOUT_MS;
  const spawnImpl = input.spawn ?? ((command, args, options) => spawn(command, [...args], {
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"]
  }));
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timer;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer !== void 0) clearTimeout(timer);
      resolve(outcome);
    };
    const lastLine = (text) => {
      const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
      return lines.at(-1) ?? "";
    };
    try {
      const child = spawnImpl(input.shim, ["update", "--cancel", "--json"], { env: input.env });
      child.stdout?.on("data", (chunk) => {
        if (stdout.length < CANCEL_OUTPUT_CAP) stdout += typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        if (stderr.length < CANCEL_OUTPUT_CAP) stderr += typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      });
      child.on("error", (error) => {
        finish({ status: "failed", message: `cancel failed to start: ${error.message}`, runId: "", pid: null, phase: "" });
      });
      child.on("close", (code) => {
        const parsed = parseCancelJson(stdout);
        if (parsed === null) {
          const message2 = lastLine(stderr) || lastLine(stdout) || `cancel exited ${String(code)} without a result`;
          finish({ status: "failed", message: message2, runId: "", pid: null, phase: "" });
          return;
        }
        const message = lastLine(stderr) || lastLine(stdout);
        finish({ ...parsed, message });
      });
      timer = setTimeout(() => {
        try {
          child.kill?.();
        } catch {
        }
        finish({ status: "failed", message: `cancel timed out after ${String(timeoutMs)}ms`, runId: "", pid: null, phase: "" });
      }, timeoutMs);
      timer.unref?.();
    } catch (error) {
      finish({
        status: "failed",
        message: `cancel failed: ${error instanceof Error ? error.message : String(error)}`,
        runId: "",
        pid: null,
        phase: ""
      });
    }
  });
}

// src/marker.ts
import { execFileSync } from "node:child_process";
import { readFileSync as readFileSync3 } from "node:fs";
import { join as join4 } from "node:path";

// src/run.ts
import { existsSync, mkdirSync, readFileSync as readFileSync2, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join as join3 } from "node:path";
var RUN_STEP_TOTAL = 9;
var APPLY_SWITCH_STEP = 8;
function executingPhase(mode) {
  return mode === "apply" ? "applying" : "preparing";
}
function phaseForResult(result) {
  return result;
}
function isTerminalPhase(phase) {
  return phase === "success" || phase === "failed" || phase === "rolledback" || phase === "cancelled";
}
function isPreparedPhase(phase) {
  return phase === "prepared";
}
function modeFlag(mode) {
  if (mode === "prepare") return "--prepare";
  if (mode === "apply") return "--apply";
  return "one-shot";
}
function rungForMode(mode) {
  return mode === "one-shot" ? "one-shot" : "two-phase";
}
function modeLabel(mode) {
  return mode === "one-shot" ? "update" : mode;
}
var LOG_TAIL_LINES = 40;
var LOG_TAIL_BYTES = 64 * 1024;
var RUN_STALE_WINDOW_MS = 5 * 6e4;
function fileMtimeMs(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}
function progressAgeMs(paths, nowMs) {
  let newest = 0;
  let found = false;
  for (const path of paths) {
    const mtime = fileMtimeMs(path);
    if (mtime === null) continue;
    found = true;
    if (mtime > newest) newest = mtime;
  }
  return found ? Math.max(0, nowMs - newest) : null;
}
function isProgressStale(ageMs, staleWindowMs = RUN_STALE_WINDOW_MS) {
  return ageMs !== null && ageMs > staleWindowMs;
}
function readStagedApply(prefix) {
  try {
    const parsed = JSON.parse(readFileSync2(stagedApplyPath(prefix), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const raw = parsed;
    if (typeof raw.version !== "string" || raw.version === "") return null;
    if (typeof raw.treeDirName !== "string" || raw.treeDirName === "") return null;
    return {
      version: raw.version,
      treeDirName: raw.treeDirName,
      channel: typeof raw.channel === "string" ? raw.channel : "stable",
      preparedAt: typeof raw.preparedAt === "string" ? raw.preparedAt : ""
    };
  } catch {
    return null;
  }
}
var STEP_MARKER = /\[(\d+)\/(\d+)\]/;
var ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
function plain(line) {
  return line.replace(ANSI, "").replace(/\r/g, "").trimEnd();
}
function resultFromLine(line) {
  if (/rolled back/i.test(line)) return "rolledback";
  if (/successfully updated|already up to date|update applied:/i.test(line)) return "success";
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
  return { step, steps, lastLine, logTail, result };
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
  return join3(home, "update-check");
}
function runRecordPath(home) {
  return join3(updateCheckDir(home), "run.json");
}
function runLogPath(home) {
  return join3(updateCheckDir(home), "run.log");
}
function runPidPath(home) {
  return join3(updateCheckDir(home), "run.pid");
}
function stagedApplyPath(prefix) {
  return join3(prefix, "harness", ".staged-apply.json");
}
function hasStagedApply(prefix) {
  return existsSync(stagedApplyPath(prefix));
}
function isUpdatePhase(value) {
  return value === "starting" || value === "prepared" || value === "preparing" || value === "applying" || value === "success" || value === "failed" || value === "rolledback" || value === "cancelled";
}
function isUpdateResult(value) {
  return value === "success" || value === "failed" || value === "rolledback" || value === "cancelled";
}
function normalizeRunRecord(raw) {
  const mode = raw.mode === "apply" || raw.mode === "one-shot" ? raw.mode : "prepare";
  const rung = raw.rung === "two-phase" || raw.rung === "one-shot" ? raw.rung : rungForMode(mode);
  const launcher = typeof raw.launcher === "string" && raw.launcher !== "" ? raw.launcher : typeof raw.rung === "string" && raw.rung !== "two-phase" && raw.rung !== "one-shot" ? raw.rung : "pending";
  const finishedAt = typeof raw.finishedAt === "string" ? raw.finishedAt : void 0;
  const reason = typeof raw.reason === "string" ? raw.reason : void 0;
  return {
    runId: String(raw.runId),
    target: typeof raw.target === "string" ? raw.target : "",
    channel: typeof raw.channel === "string" ? raw.channel : "stable",
    mode,
    rung,
    launcher,
    phase: isUpdatePhase(raw.phase) ? raw.phase : "failed",
    step: typeof raw.step === "number" && Number.isFinite(raw.step) ? raw.step : 0,
    steps: typeof raw.steps === "number" && raw.steps > 0 ? raw.steps : RUN_STEP_TOTAL,
    lastLine: typeof raw.lastLine === "string" ? raw.lastLine : "",
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "",
    pid: typeof raw.pid === "number" && Number.isFinite(raw.pid) ? raw.pid : null,
    logPath: typeof raw.logPath === "string" ? raw.logPath : "",
    result: isUpdateResult(raw.result) ? raw.result : null,
    staged: raw.staged === true,
    logTail: Array.isArray(raw.logTail) ? raw.logTail.filter((line) => typeof line === "string") : [],
    ...raw.observed === true ? { observed: true } : {},
    ...finishedAt === void 0 ? {} : { finishedAt },
    ...reason === void 0 ? {} : { reason }
  };
}
function isRunRecordShape(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value;
  return typeof record.runId === "string" && typeof record.target === "string" && typeof record.phase === "string" && typeof record.startedAt === "string" && typeof record.logPath === "string" && (record.result === null || record.result === "success" || record.result === "failed" || record.result === "rolledback" || record.result === "cancelled");
}
function readRunRecord(file) {
  try {
    const parsed = JSON.parse(readFileSync2(file, "utf8"));
    return isRunRecordShape(parsed) ? normalizeRunRecord(parsed) : null;
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
  if (record.result !== null || isPreparedPhase(record.phase)) return false;
  const pid = effectivePid(home, record);
  return pid !== null && isProcessAlive(pid);
}
function terminalRecord(record, result, now, staged) {
  return {
    ...record,
    phase: phaseForResult(result),
    result,
    staged,
    finishedAt: now().toISOString(),
    ...result === "success" ? {} : { reason: record.lastLine === "" ? `${record.mode} run reported ${result}` : record.lastLine }
  };
}
function preparedRecord(record, now = () => /* @__PURE__ */ new Date()) {
  return { ...record, phase: "prepared", result: null, staged: true, finishedAt: now().toISOString() };
}
function reconcileRunRecord(record, identity, context, options = {}) {
  const now = context.now ?? (() => /* @__PURE__ */ new Date());
  if (record.result !== null) return { record, changed: false };
  const live2 = options.live ?? isRunActive(context.home, record);
  if (live2) return { record, changed: false };
  const staged = hasStagedApply(context.prefix);
  const parsed = readRunLog(record.logPath);
  if (parsed.result !== null) {
    const next = terminalRecord(parsed.lastLine === "" ? record : { ...record, lastLine: parsed.lastLine }, parsed.result, now, staged);
    return { record: next, changed: true };
  }
  if (isPreparedPhase(record.phase) && staged) {
    if (record.staged) return { record, changed: false };
    return { record: { ...record, staged: true }, changed: true };
  }
  if (record.mode === "prepare" && staged) {
    return { record: { ...preparedRecord(record), lastLine: parsed.lastLine === "" ? record.lastLine : parsed.lastLine, logTail: parsed.logTail }, changed: true };
  }
  if (identity.version !== "" && identity.version === record.target) {
    return { record: { ...terminalRecord(record, "success", now, staged), lastLine: parsed.lastLine === "" ? record.lastLine : parsed.lastLine, logTail: parsed.logTail }, changed: true };
  }
  const version = identity.version === "" ? "unknown" : identity.version;
  const action = modeLabel(record.mode);
  return {
    record: {
      ...record,
      phase: "failed",
      result: "failed",
      staged,
      finishedAt: now().toISOString(),
      lastLine: parsed.lastLine === "" ? record.lastLine : parsed.lastLine,
      logTail: parsed.logTail,
      reason: `the ${action} run is no longer running and the install version (${version}) does not match the target (${record.target})`
    },
    changed: true
  };
}
function sameRunRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

// src/marker.ts
var RUN_MARKER_FILE = ".update-run.json";
function runMarkerPath(prefix) {
  return join4(prefix, "harness", RUN_MARKER_FILE);
}
var MARKER_MODES = ["plain", "prepare", "apply", "one-shot"];
var MARKER_PHASES = ["running", "switching", "applying", "done", "failed", "rolledback", "cancelled"];
function isMarkerMode(value) {
  return typeof value === "string" && MARKER_MODES.includes(value);
}
function isMarkerPhase(value) {
  return typeof value === "string" && MARKER_PHASES.includes(value);
}
function readRunMarker(prefix) {
  try {
    const parsed = JSON.parse(readFileSync3(runMarkerPath(prefix), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const raw = parsed;
    if (typeof raw.runId !== "string" || typeof raw.pid !== "number" || !Number.isFinite(raw.pid)) return null;
    if (!isMarkerMode(raw.mode) || !isMarkerPhase(raw.phase)) return null;
    return {
      runId: raw.runId,
      pid: Math.trunc(raw.pid),
      mode: raw.mode,
      step: typeof raw.step === "number" && Number.isFinite(raw.step) ? raw.step : 0,
      steps: typeof raw.steps === "number" && raw.steps > 0 ? raw.steps : 0,
      phase: raw.phase,
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "",
      logPath: typeof raw.logPath === "string" ? raw.logPath : "",
      version: typeof raw.version === "string" ? raw.version : "",
      target: typeof raw.target === "string" ? raw.target : ""
    };
  } catch {
    return null;
  }
}
function isProcessLive(pid, platform = process.platform) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === "EPERM";
  }
  if (platform === "linux") {
    try {
      const stat = readFileSync3(`/proc/${String(pid)}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[0];
      return state !== void 0 && !state.startsWith("Z") && state !== "X";
    } catch {
      return false;
    }
  }
  try {
    const out = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return out !== "" && !out.startsWith("Z") && !out.startsWith("X");
  } catch {
    return true;
  }
}
function isMarkerLive(marker, isAlive = isProcessLive, options = {}) {
  if (resultFromMarkerPhase(marker.phase) !== null) return false;
  if (marker.pid <= 0 || !isAlive(marker.pid)) return false;
  const age = options.progressAgeMs;
  if (age !== void 0 && isProgressStale(age, options.staleWindowMs ?? RUN_STALE_WINDOW_MS)) return false;
  return true;
}
function markerProgressAge(marker, prefix, nowMs) {
  return progressAgeMs([runMarkerPath(prefix), ...marker.logPath === "" ? [] : [marker.logPath]], nowMs);
}
function modeFromMarker(mode) {
  if (mode === "prepare") return "prepare";
  if (mode === "apply") return "apply";
  return "one-shot";
}
function phaseFromMarker(phase) {
  switch (phase) {
    case "running":
      return "preparing";
    case "switching":
      return "applying";
    case "applying":
      return "applying";
    case "done":
      return "success";
    case "failed":
      return "failed";
    case "rolledback":
      return "rolledback";
    case "cancelled":
      return "cancelled";
  }
}
function resultFromMarkerPhase(phase) {
  if (phase === "done") return "success";
  if (phase === "failed" || phase === "rolledback" || phase === "cancelled") return phase;
  return null;
}
function observedRecordFromMarker(marker, context) {
  const mode = modeFromMarker(marker.mode);
  const parsed = context.readLog === void 0 ? marker.logPath === "" ? { lastLine: "", logTail: [] } : readRunLog(marker.logPath) : context.readLog(marker.logPath);
  const result = resultFromMarkerPhase(marker.phase);
  const finishedAt = result === null ? void 0 : marker.startedAt === "" ? void 0 : marker.startedAt;
  return {
    runId: marker.runId,
    target: marker.target !== "" ? marker.target : marker.version,
    channel: context.channel,
    mode,
    rung: rungForMode(mode),
    phase: phaseFromMarker(marker.phase),
    step: marker.step,
    steps: marker.steps === 0 ? 9 : marker.steps,
    lastLine: parsed.lastLine,
    startedAt: marker.startedAt,
    pid: marker.pid,
    logPath: marker.logPath,
    result,
    launcher: "external",
    staged: hasStagedApply(context.prefix),
    logTail: [...parsed.logTail],
    observed: true,
    ...finishedAt === void 0 ? {} : { finishedAt },
    ...result === null || result === "success" ? {} : { reason: parsed.lastLine }
  };
}

// src/probe.ts
import { spawn as spawn2 } from "node:child_process";
var ENGINE_PROBE_TIMEOUT_MS = 1e4;
var ENGINE_PROBE_OUTPUT_CAP = 64 * 1024;
function probeEngineCapability(input) {
  const timeoutMs = input.timeoutMs ?? ENGINE_PROBE_TIMEOUT_MS;
  const spawnImpl = input.spawn ?? ((command, args, options) => spawn2(command, [...args], {
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"]
  }));
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== void 0) clearTimeout(timer);
      resolve(result);
    };
    try {
      const child = spawnImpl(input.shim, ["update", "--help"], { env: input.env });
      const collect = (chunk) => {
        if (output.length >= ENGINE_PROBE_OUTPUT_CAP) return;
        output += typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.on("error", (error) => {
        finish({ capability: "unsupported", reason: `probe failed to start: ${error.message}` });
      });
      child.on("close", (code) => {
        if (output.includes("--prepare")) {
          finish({ capability: "supported" });
          return;
        }
        finish({
          capability: "unsupported",
          reason: output.trim() === "" ? `probe produced no output (exit ${String(code)})` : `engine help does not list --prepare (exit ${String(code)})`
        });
      });
      timer = setTimeout(() => {
        try {
          child.kill?.();
        } catch {
        }
        finish({ capability: "unsupported", reason: `probe timed out after ${String(timeoutMs)}ms` });
      }, timeoutMs);
      timer.unref?.();
    } catch (error) {
      finish({ capability: "unsupported", reason: `probe failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  });
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
function resolvePrefix(home) {
  try {
    const state = JSON.parse(
      readFileSync4(join5(home, "harness", "install-state.json"), "utf8")
    );
    return typeof state.prefix === "string" && state.prefix !== "" ? state.prefix : home;
  } catch {
    return home;
  }
}
function resolveShimPath(home) {
  let binDir = "";
  try {
    const state = JSON.parse(
      readFileSync4(join5(home, "harness", "install-state.json"), "utf8")
    );
    binDir = typeof state.binDir === "string" ? state.binDir : "";
  } catch {
    binDir = "";
  }
  const candidates = [...binDir === "" ? [] : [join5(binDir, "dsh")], defaultShimPath()];
  return candidates.find((candidate) => existsSync2(candidate)) ?? null;
}
var UpdateRunController = class {
  options;
  now;
  prefix;
  record = null;
  loaded = false;
  watcher = null;
  capability = null;
  timers;
  /**
   * @param options - home, identity/status readers, launch and timer seams.
   */
  constructor(options) {
    this.options = options;
    this.now = options.now ?? (() => /* @__PURE__ */ new Date());
    this.prefix = (options.resolvePrefix ?? resolvePrefix)(options.home);
    this.timers = options.timers ?? {
      setInterval: (handler, delayMs) => {
        return setInterval(handler, delayMs);
      },
      clearInterval: (handle) => {
        clearInterval(handle);
      }
    };
  }
  /**
   * The current run as the UI should see it: the plugin's own executing record
   * first, otherwise a live run observed from the engine marker (a
   * terminal-started update), otherwise the plugin's persisted record
   * (prepared or terminal). The marker costs one small file read per call and
   * is never watched host-side.
   */
  run() {
    this.healStaleOwn();
    const own = this.loadOwn();
    if (own !== null && own.result === null && !isPreparedPhase(own.phase) && this.blockingRun(own)) return own;
    return this.observeEngineRun() ?? own;
  }
  /** The persisted plugin record (loaded once). */
  loadOwn() {
    if (!this.loaded) {
      this.loaded = true;
      this.record = readRunRecord(runRecordPath(this.options.home));
    }
    return this.record;
  }
  /** Whether a marker names the same run as the persisted record (log path, or mode/target). */
  markerMatchesRecord(record, marker) {
    if (record.logPath !== "" && marker.logPath !== "" && record.logPath === marker.logPath) return true;
    if (modeFromMarker(marker.mode) !== record.mode) return false;
    return record.target === "" || marker.target === "" || marker.target === record.target || marker.version === record.target;
  }
  /** Synthesize a live record from the engine marker, or null when none is live. */
  observeEngineRun() {
    const marker = readRunMarker(this.prefix);
    if (marker === null) return null;
    if (!isMarkerLive(marker, this.options.isAlive ?? isProcessLive, {
      progressAgeMs: markerProgressAge(marker, this.prefix, this.now().getTime())
    })) return null;
    return observedRecordFromMarker(marker, {
      prefix: this.prefix,
      channel: this.options.readIdentity().channel
    });
  }
  /**
   * Whether the engine's own truth names a live run: a live non-terminal,
   * non-stalled marker, or the mkdir-fallback lock's live owner pid. The
   * flock file's presence means nothing (flock releases without removing it),
   * so it is never consulted.
   */
  engineRunActive() {
    const marker = readRunMarker(this.prefix);
    if (marker !== null && isMarkerLive(marker, this.options.isAlive ?? isProcessLive, {
      progressAgeMs: markerProgressAge(marker, this.prefix, this.now().getTime())
    })) return true;
    const lockPid = readRunPid(join5(this.prefix, "harness", ".update.lock.d", "pid"));
    return lockPid !== null && (this.options.isAlive ?? isProcessLive)(lockPid);
  }
  /** Whether the engine's live run is the same run as the persisted record. */
  engineRunActiveFor(record) {
    if (!this.engineRunActive()) return false;
    const marker = readRunMarker(this.prefix);
    return marker !== null && this.markerMatchesRecord(record, marker);
  }
  /**
   * Auto-heal a stale persisted record: not live by pid, and either the engine
   * agrees nothing runs or the engine runs something else. The record is
   * reconciled to a terminal state (success when the install already reached
   * the target, otherwise failed with a clear reason) and the dead pid file is
   * dropped, so no gate can refuse on state that is not real. Runs younger
   * than the start grace and prepared records are left alone.
   */
  healStaleOwn() {
    const own = this.loadOwn();
    if (own === null || own.result !== null || isPreparedPhase(own.phase)) return;
    const startedAtMs = Date.parse(own.startedAt);
    if (Number.isFinite(startedAtMs) && this.now().getTime() - startedAtMs < RUN_START_GRACE_MS) return;
    if (this.isAliveRecord(own) || this.engineRunActiveFor(own)) return;
    const { record, changed } = reconcileRunRecord(own, this.options.readIdentity(), {
      home: this.options.home,
      prefix: this.prefix,
      now: this.now
    }, { live: false });
    if (changed) this.persist(record);
    this.stopWatcher();
    try {
      rmSync(runPidPath(this.options.home), { force: true });
    } catch {
    }
  }
  /**
   * One installed-engine capability probe per controller (one plugin boot):
   * `dsh update --help` bounded, cached forever after. Failures default to
   * UNSUPPORTED, so the first update on an old engine uses the one-shot rung.
   * @returns the cached probe promise.
   */
  probe() {
    this.capability ??= this.runProbe();
    return this.capability;
  }
  async runProbe() {
    const shim = (this.options.resolveShim ?? resolveShimPath)(this.options.home);
    if (shim === null) {
      return { capability: "unsupported", reason: `the dsh shim was not found (checked the recorded binDir and ${defaultShimPath()})` };
    }
    return await (this.options.probe ?? probeEngineCapability)({
      shim,
      env: this.probeEnvironment(),
      ...this.options.probeTimeoutMs === void 0 ? {} : { timeoutMs: this.options.probeTimeoutMs }
    });
  }
  /** The probe's environment: the composed runtime PATH where one resolves, plus DSH_HOME/PREFIX. */
  probeEnvironment() {
    const baseEnv = this.options.baseEnv ?? process.env;
    const resolved = resolveRuntimePath({
      prefix: this.prefix,
      homeDir: this.options.probeHomeDir ?? homedir2(),
      baseEnv,
      ...this.options.platform === void 0 ? {} : { platform: this.options.platform }
    });
    return {
      ...baseEnv,
      ...resolved.path === null ? {} : { PATH: resolved.path },
      [RUN_HOME_ENV]: this.options.home,
      ...this.prefix === "" ? {} : { PREFIX: this.prefix }
    };
  }
  /**
   * Boot reconcile: resolve a record left by a dead watcher. Idempotent.
   * A prepared record survives untouched; a live updater resumes watching.
   * @returns the reconciled record, or null when none exists.
   */
  reconcile() {
    const current = this.loadOwn();
    if (current === null) return null;
    if (current.result === null && !isPreparedPhase(current.phase) && this.blockingRun(current)) {
      const marker = readRunMarker(this.prefix);
      const markerLive = marker !== null && isMarkerLive(marker, this.options.isAlive ?? isProcessLive, {
        progressAgeMs: markerProgressAge(marker, this.prefix, this.now().getTime())
      });
      if (marker !== null && markerLive && this.markerMatchesRecord(current, marker)) {
        const merged = {
          ...current,
          pid: marker.pid,
          // The marker knows when the switch began even if the log parse lags;
          // `running` keeps the finer log-derived phase.
          phase: marker.phase === "switching" ? "applying" : marker.phase === "running" ? current.phase : phaseFromMarker(marker.phase),
          step: marker.step > 0 ? marker.step : current.step,
          steps: marker.steps > 0 ? marker.steps : current.steps
        };
        this.watch(merged);
        return merged;
      }
      this.watch(current);
      return current;
    }
    if (isPreparedPhase(current.phase) && hasStagedApply(this.prefix)) return current;
    const { record, changed } = reconcileRunRecord(current, this.options.readIdentity(), {
      home: this.options.home,
      prefix: this.prefix,
      now: this.now
    }, { live: false });
    if (changed) this.persist(record);
    try {
      rmSync(runPidPath(this.options.home), { force: true });
    } catch {
    }
    return record;
  }
  /**
   * Start one update run. The probe decides the rung: a two-phase engine gets
   * `dsh update --channel <c> --prepare` (the staged tree waits for `apply`),
   * an older engine gets the one-shot `dsh update --channel <c>` whose run
   * includes the switch and restart.
   *
   * A dismissed version is startable (the skip only hides the indicator), and
   * an already-prepared update is deliberately refused (`already-prepared`):
   * the staged target is pinned by the engine's record, so the offered action
   * is Restart to update, not prepare again.
   *
   * @returns the freshly persisted record.
   * @throws RunRefusedError when no update is available, a run is active, an
   *   update is already prepared, the shim is missing, or the launch fails
   *   (including a launch environment with no usable Node.js runtime).
   */
  async start() {
    this.reconcile();
    const status = this.options.readStatus();
    if (status.state !== "available" && status.state !== "dismissed" || status.latest === void 0) {
      throw new RunRefusedError(
        "not-available",
        `updateCheck.start: no update is available (state=${status.state})`
      );
    }
    const current = this.run();
    if (current !== null && current.result === null) {
      if (isPreparedPhase(current.phase)) {
        throw new RunRefusedError(
          "already-prepared",
          `updateCheck.start: update ${current.target} is already prepared; apply it instead`
        );
      }
      if (this.blockingRun(current)) {
        throw new RunRefusedError(
          "already-running",
          `updateCheck.start: an update is already running (run ${current.runId}, step ${String(current.step)}/${String(current.steps)})`
        );
      }
    }
    const pin = { target: status.latest.version, channel: status.current.channel };
    const capability = await this.probe();
    return capability.capability === "supported" ? this.begin("prepare", pin) : this.begin("one-shot", pin);
  }
  /**
   * Apply the staged update (`dsh update --apply`).
   *
   * @returns the freshly persisted record.
   * @throws RunRefusedError when nothing is prepared, the record is a one-shot
   *   update (its run owns the restart), the staged marker is missing, a run
   *   is active, the shim is missing, or the launch fails.
   */
  apply() {
    this.reconcile();
    const current = this.run();
    if (current !== null && this.blockingRun(current)) {
      throw new RunRefusedError(
        "already-running",
        `updateCheck.apply: an update is already running (run ${current.runId})`
      );
    }
    if (current !== null && current.mode === "one-shot") {
      throw new RunRefusedError(
        "not-prepared",
        `updateCheck.apply: run ${current.runId} is a one-shot update (this engine has no --prepare); there is nothing to apply \u2014 the run restarts the service itself when it switches`
      );
    }
    const revisableFailure = current !== null && current.result !== null && current.result !== "success" && current.staged === true;
    if (current === null || !isPreparedPhase(current.phase) && !revisableFailure) {
      throw new RunRefusedError(
        "not-prepared",
        "updateCheck.apply: no prepared update is staged; run Update now first"
      );
    }
    if (!hasStagedApply(this.prefix)) {
      throw new RunRefusedError(
        "not-prepared",
        "updateCheck.apply: the staged apply marker is gone; run Update now to prepare again"
      );
    }
    const staged = readStagedApply(this.prefix);
    return this.begin("apply", {
      target: staged?.version ?? current.target,
      channel: staged?.channel ?? current.channel
    });
  }
  /**
   * Clear stale update state so a stuck failure can recover: refuses while
   * anything is genuinely live (the observer's view, the persisted record by
   * strong liveness, or the engine's own marker/mkdir-lock truth), then heals
   * the persisted record to a terminal state and drops the dead pid file. The
   * engine's marker and the staged tree are never touched, so a valid staged
   * update survives for an immediate re-apply.
   *
   * @returns the run record after clearing (terminal, or observed when the
   *   engine started something in the meantime).
   * @throws RunRefusedError when a live run or the engine's live lock exists.
   */
  clearStale() {
    const observed = this.observeEngineRun();
    if (observed !== null && this.isAliveRecord(observed)) {
      throw new RunRefusedError(
        "already-running",
        `updateCheck.clearStale: run ${observed.runId} is live (${observed.phase}); cancel it or wait`
      );
    }
    const own = this.loadOwn();
    if (own !== null && this.isAliveRecord(own)) {
      throw new RunRefusedError(
        "already-running",
        `updateCheck.clearStale: run ${own.runId} is live (${own.phase}); cancel it or wait`
      );
    }
    if (this.engineRunActive()) {
      throw new RunRefusedError(
        "already-running",
        "updateCheck.clearStale: the engine still holds a live update lock; wait for it or cancel it"
      );
    }
    if (own !== null && own.result === null && !isPreparedPhase(own.phase)) {
      const { record } = reconcileRunRecord(own, this.options.readIdentity(), {
        home: this.options.home,
        prefix: this.prefix,
        now: this.now
      }, { live: false });
      this.persist(record);
      this.stopWatcher();
    }
    try {
      rmSync(runPidPath(this.options.home), { force: true });
    } catch {
    }
    return this.run();
  }
  /**
   * Cancel the live run through the engine's own `dsh update --cancel --json`
   * (bounded), so the pre-switch/sweep/refusal rules stay in the engine. On a
   * successful cancel the record is relayed into `cancelled`: the plugin's own
   * record when it started the run, otherwise one synthesized from the (now
   * terminal) engine marker.
   *
   * @returns the engine's outcome and the resulting record.
   * @throws RunRefusedError when the shim is missing.
   */
  async cancel() {
    const current = this.run();
    const shim = (this.options.resolveShim ?? resolveShimPath)(this.options.home);
    if (shim === null) {
      throw new RunRefusedError(
        "shim-missing",
        `updateCheck.cancel: the dsh shim was not found (checked the recorded binDir and ${defaultShimPath()})`
      );
    }
    const outcome = await (this.options.cancelEngine ?? cancelEngineRun)({
      shim,
      env: this.probeEnvironment(),
      ...this.options.cancelTimeoutMs === void 0 ? {} : { timeoutMs: this.options.cancelTimeoutMs }
    });
    if (outcome.status !== "cancelled") {
      return { status: outcome.status, message: outcome.message, record: current };
    }
    return { status: "cancelled", message: outcome.message, record: this.relayCancelled(current) };
  }
  /** Relay a successful engine cancel into the record the UI renders. */
  relayCancelled(current) {
    if (current !== null && current.observed !== true) {
      const next = this.terminalRecord(current, "cancelled");
      this.persist(next);
      this.stopWatcher();
      return next;
    }
    const marker = readRunMarker(this.prefix);
    if (marker === null) return current;
    const record = observedRecordFromMarker(marker, {
      prefix: this.prefix,
      channel: this.options.readIdentity().channel
    });
    this.loaded = true;
    this.persist(record);
    return record;
  }
  /** Stop the watcher (plugin unload). The updater itself keeps running. */
  dispose() {
    this.stopWatcher();
  }
  /** Persist a fresh record for `mode`, launch its engine invocation, and watch it. */
  begin(mode, pin) {
    const shim = (this.options.resolveShim ?? resolveShimPath)(this.options.home);
    if (shim === null) {
      throw new RunRefusedError(
        "shim-missing",
        `updateCheck.${mode === "apply" ? "apply" : "start"}: the dsh shim was not found (checked the recorded binDir and ${defaultShimPath()})`
      );
    }
    const home = this.options.home;
    const logPath = runLogPath(home);
    const pidFile = runPidPath(home);
    const base = {
      runId: (this.options.runId ?? (() => randomUUID().replace(/-/g, "").slice(0, 10)))(),
      target: pin.target,
      channel: pin.channel,
      mode,
      rung: rungForMode(mode),
      phase: "starting",
      step: 0,
      steps: RUN_STEP_TOTAL,
      lastLine: "",
      startedAt: this.now().toISOString(),
      pid: null,
      logPath,
      result: null,
      launcher: "pending",
      staged: mode === "apply" ? hasStagedApply(this.prefix) : false,
      logTail: []
    };
    try {
      mkdirSync2(dirname2(logPath), { recursive: true });
      writeFileSync2(logPath, "");
      rmSync(pidFile, { force: true });
    } catch {
    }
    this.loaded = true;
    this.persist(base);
    this.launch(base, shim);
    return this.run() ?? base;
  }
  /** Launch through the ladder, persist the outcome, and start watching. */
  launch(record, shim) {
    const home = this.options.home;
    let outcome;
    try {
      const input = {
        home,
        prefix: this.prefix,
        shim,
        flag: modeFlag(record.mode),
        ...record.mode === "apply" ? {} : { channel: record.channel },
        runId: record.runId,
        logPath: record.logPath,
        pidFile: runPidPath(home),
        ...this.options.platform === void 0 ? {} : { platform: this.options.platform },
        ...this.options.hasCommand === void 0 ? {} : { hasCommand: this.options.hasCommand },
        ...this.options.uid === void 0 ? {} : { uid: this.options.uid },
        ...this.options.baseEnv === void 0 ? {} : { baseEnv: this.options.baseEnv },
        ...this.options.probeHomeDir === void 0 ? {} : { probeHomeDir: this.options.probeHomeDir }
      };
      outcome = (this.options.launch ?? launchUpdater)(input);
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
      const verb = error instanceof LaunchEnvironmentError ? "updateCheck.start" : `updateCheck.${record.mode === "apply" ? "apply" : "start"}`;
      throw new RunRefusedError("launch-failed", `${verb}: could not launch the updater: ${message}`);
    }
    const started = {
      ...record,
      launcher: outcome.rung,
      rung: rungForMode(record.mode),
      pid: outcome.pid,
      phase: executingPhase(record.mode)
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
    const staged = hasStagedApply(this.prefix);
    const wrapperPid = readRunPid(runPidPath(this.options.home));
    const pid = wrapperPid ?? record.pid;
    const alive = pid !== null && (this.options.isAlive ?? isProcessAlive)(pid);
    const startedAtMs = Date.parse(record.startedAt);
    const withinGrace = wrapperPid === null && Number.isFinite(startedAtMs) && this.now().getTime() - startedAtMs < RUN_START_GRACE_MS;
    const base = {
      ...record,
      step: parsed.step > 0 ? parsed.step : record.step,
      steps: parsed.steps,
      lastLine: parsed.lastLine === "" ? record.lastLine : parsed.lastLine,
      logTail: parsed.logTail,
      pid,
      staged
    };
    if (isPreparedPhase(record.phase)) {
      if (staged) {
        this.persist(base);
        this.stopWatcher();
        return;
      }
      this.persist(this.failedRecord(base, "the staged update disappeared before it was applied"));
      this.stopWatcher();
      return;
    }
    if (parsed.result !== null) {
      this.persist(this.terminalRecord(base, parsed.result));
      if (!alive) this.stopWatcher();
      return;
    }
    if (!alive && !withinGrace) {
      if (record.mode === "prepare" && staged) {
        this.persist(preparedRecord(base, this.now));
        this.stopWatcher();
        return;
      }
      this.persist(this.failedRecord(
        base,
        parsed.lastLine === "" ? `the ${record.mode} run exited before writing any output` : `the ${record.mode} run exited before reporting a result (last line: ${parsed.lastLine})`
      ));
      this.stopWatcher();
      return;
    }
    this.persist({
      ...base,
      phase: alive || parsed.step > 0 ? executingPhase(record.mode) : record.phase
    });
  }
  /** One failed record from the current tail. */
  failedRecord(base, reason) {
    return {
      ...base,
      phase: "failed",
      result: "failed",
      finishedAt: this.now().toISOString(),
      reason
    };
  }
  /** One terminal record from the parsed result. */
  terminalRecord(base, result) {
    return {
      ...base,
      phase: result,
      result,
      finishedAt: this.now().toISOString(),
      ...result === "success" ? {} : { reason: base.lastLine === "" ? `the ${base.mode} run reported ${result}` : base.lastLine }
    };
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
  /**
   * Strong liveness: terminal/prepared records are never live; the pid must be
   * live and non-zombie; and the run's own files must have moved inside the
   * stall window — a recycled pid or a dead process behind a live-looking pid
   * never blocks. Missing file evidence counts as live (never auto-heal on
   * absent evidence).
   */
  isAliveRecord(record) {
    if (record.result !== null || isPreparedPhase(record.phase)) return false;
    const probe = this.options.isAlive ?? isProcessLive;
    if (record.observed === true) {
      if (record.pid === null || !probe(record.pid)) return false;
      const age2 = progressAgeMs(record.logPath === "" ? [] : [record.logPath], this.now().getTime());
      return !isProgressStale(age2);
    }
    const pid = effectivePid(this.options.home, record);
    if (pid === null || !probe(pid)) return false;
    const age = progressAgeMs([record.logPath], this.now().getTime());
    return !isProgressStale(age);
  }
  /** Whether a run must block a new start/apply: strong liveness, or the engine's own live run matching it. */
  blockingRun(record) {
    if (record.result !== null || isPreparedPhase(record.phase)) return false;
    return this.isAliveRecord(record) || this.engineRunActiveFor(record);
  }
};

// src/remote.ts
var UPDATE_CHECK_NAMESPACE = "updateCheck";
var _cancel_dec, _clearStale_dec, _run_dec, _apply_dec, _start_dec, _dismiss_dec, _checkNow_dec, _status_dec, _a, _init;
var UpdateCheckService = class extends (_a = TypertRemoteService, _status_dec = [Remote], _checkNow_dec = [Remote], _dismiss_dec = [Remote], _start_dec = [Remote], _apply_dec = [Remote], _run_dec = [Remote], _clearStale_dec = [Remote], _cancel_dec = [Remote], _a) {
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
  async start() {
    try {
      return await this.runs.start();
    } catch (error) {
      if (error instanceof RunRefusedError) {
        throw new RemoteError("gateway/bad-request", error.message, {});
      }
      throw error;
    }
  }
  apply() {
    try {
      return this.runs.apply();
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
  clearStale() {
    try {
      return this.runs.clearStale();
    } catch (error) {
      if (error instanceof RunRefusedError) {
        throw new RemoteError("gateway/bad-request", error.message, {});
      }
      throw error;
    }
  }
  async cancel() {
    try {
      return await this.runs.cancel();
    } catch (error) {
      if (error instanceof RunRefusedError) {
        throw new RemoteError("gateway/bad-request", error.message, {});
      }
      throw error;
    }
  }
};
_init = __decoratorStart(_a);
__decorateElement(_init, 1, "status", _status_dec, UpdateCheckService);
__decorateElement(_init, 1, "checkNow", _checkNow_dec, UpdateCheckService);
__decorateElement(_init, 1, "dismiss", _dismiss_dec, UpdateCheckService);
__decorateElement(_init, 1, "start", _start_dec, UpdateCheckService);
__decorateElement(_init, 1, "apply", _apply_dec, UpdateCheckService);
__decorateElement(_init, 1, "run", _run_dec, UpdateCheckService);
__decorateElement(_init, 1, "clearStale", _clearStale_dec, UpdateCheckService);
__decorateElement(_init, 1, "cancel", _cancel_dec, UpdateCheckService);
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
import { mkdirSync as mkdirSync3, readFileSync as readFileSync5, renameSync as renameSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname3 } from "node:path";
function readDismissedVersion(file) {
  try {
    const record = JSON.parse(readFileSync5(file, "utf8"));
    return typeof record.version === "string" && record.version !== "" ? record.version : null;
  } catch {
    return null;
  }
}
function writeDismissedVersion(file, version, now = () => /* @__PURE__ */ new Date()) {
  try {
    mkdirSync3(dirname3(file), { recursive: true });
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
    void runs.probe().then((capability) => {
      if (capability.capability === "supported") {
        ctx.logger.debug("enpoi-update-check: engine supports --prepare (two-phase rung)");
      } else {
        ctx.logger.info(`enpoi-update-check: engine does not support --prepare (one-shot rung) \u2014 ${capability.reason ?? "no reason recorded"}`);
      }
    });
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
  APPLY_SWITCH_STEP,
  CANCEL_OUTPUT_CAP,
  CANCEL_TIMEOUT_MS,
  CATALOG_FETCH_TIMEOUT_MS,
  CATALOG_RAW_BASE_URL,
  CATALOG_SCHEMA_VERSION,
  Config,
  ENGINE_PROBE_OUTPUT_CAP,
  ENGINE_PROBE_TIMEOUT_MS,
  FIRST_CHECK_DELAY_MS,
  LOG_TAIL_BYTES,
  LOG_TAIL_LINES,
  LaunchEnvironmentError,
  RUN_HOME_ENV,
  RUN_MARKER_FILE,
  RUN_STALE_WINDOW_MS,
  RUN_START_GRACE_MS,
  RUN_STEP_TOTAL,
  RunRefusedError,
  UPDATE_CHECK_NAMESPACE,
  UPDATE_MODE_ENV,
  UpdateCheckCore,
  UpdateCheckService,
  UpdateRunController,
  apply,
  cancelEngineRun,
  catalogUrl,
  commandOnPath,
  compareVersions,
  defaultShimPath,
  effectivePid,
  executingPhase,
  fetchCatalog,
  fileMtimeMs,
  hasStagedApply,
  inject,
  isMarkerLive,
  isPreparedPhase,
  isProcessAlive,
  isProcessLive,
  isProgressStale,
  isRunActive,
  isTerminalPhase,
  jitteredDelay,
  launchPlan,
  launchUpdater,
  launchWrapper,
  markerProgressAge,
  modeFlag,
  modeFromMarker,
  modeLabel,
  name,
  observedRecordFromMarker,
  parseCancelJson,
  parseCatalogDocument,
  parseRunLog,
  phaseForResult,
  phaseFromMarker,
  preparedRecord,
  probeEngineCapability,
  progressAgeMs,
  readDismissedVersion,
  readInstallIdentity,
  readRunLog,
  readRunMarker,
  readRunPid,
  readRunRecord,
  readStagedApply,
  reconcileRunRecord,
  resolveLaunchEnvironment,
  resolvePrefix,
  resolveRuntime,
  resolveRuntimePath,
  resolveShimPath,
  resultFromLine,
  resultFromMarkerPhase,
  runLogPath,
  runMarkerPath,
  runPidPath,
  runRecordPath,
  rungForMode,
  sameRunRecord,
  stagedApplyPath,
  startUpdateCheckSchedule,
  systemBinDirs,
  terminalRecord,
  updateCheckDir,
  wrapperArgs,
  writeDismissedVersion,
  writeRunRecord
};
