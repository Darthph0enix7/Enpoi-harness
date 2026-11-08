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
import { createHash as createHash2, randomUUID as randomUUID3 } from "node:crypto";
import { existsSync as existsSync2, mkdirSync as mkdirSync5, readFileSync as readFileSync5, renameSync as renameSync4, rmSync as rmSync4, statSync, writeFileSync as writeFileSync5 } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join as join5 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Schema from "@deepseek-ai/schemastery";

// src/jobs.ts
import { mkdirSync as mkdirSync2, readdirSync as readdirSync2, readFileSync as readFileSync2, renameSync, rmSync, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";

// src/provider-lock.ts
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
var LOCK_DIRECTORY = "locks";
var LOCK_VERSION = 1;
var MAX_ACQUIRE_ATTEMPTS = 5;
var GENERATION_FILE = /^(\d{12})\.lock$/;
var MAX_GENERATION = 999999999999;
var MAX_EPOCH_MS = 864e13;
var PROCESS_START_TIMEOUT_MS = 5e3;
var HeavyProviderLockedError = class extends Error {
  /**
   * @param path - the highest lock generation that refused acquisition.
   * @param owner - the recorded holder, when the record was readable.
   */
  constructor(path, owner) {
    super(
      owner === void 0 ? `heavy-provider lock at ${path} is held` : `heavy-provider lock at ${path} is held by pid ${String(owner.pid)} (started ${new Date(owner.startedAt).toISOString()})`
    );
    this.path = path;
    this.owner = owner;
    this.name = "HeavyProviderLockedError";
  }
};
var HeavyProviderLockUnreadableError = class extends Error {
  /**
   * @param path - the lock path that failed inspection.
   * @param reason - the concrete inspection failure.
   */
  constructor(path, reason) {
    super(`heavy-provider lock at ${path} ${reason}; refusing to reclaim it automatically`);
    this.path = path;
    this.name = "HeavyProviderLockUnreadableError";
  }
};
var liveTokens = /* @__PURE__ */ new Map();
function errorCode(error) {
  return error?.code;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function lockDirectory(jobDir, id) {
  return join(jobDir, LOCK_DIRECTORY, encodeURIComponent(id));
}
function readLinuxProcess(pid) {
  if (process.platform !== "linux") return void 0;
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const closing = stat.lastIndexOf(")");
    if (closing < 0) return void 0;
    const fields = stat.slice(closing + 1).trim().split(/\s+/);
    const state = fields[0];
    const start = fields[19];
    if (state === void 0 || start === void 0 || !/^\d+$/.test(start)) return void 0;
    return { state, start };
  } catch {
    return void 0;
  }
}
function readProcessStart(pid) {
  if (process.platform === "linux") return readLinuxProcess(pid)?.start;
  if (process.platform !== "darwin") return void 0;
  try {
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: PROCESS_START_TIMEOUT_MS,
      windowsHide: true
    });
    if (result.error !== void 0 || result.status !== 0) return void 0;
    const stamp = typeof result.stdout === "string" ? result.stdout.trim() : "";
    return stamp === "" ? void 0 : `ps:${stamp}`;
  } catch {
    return void 0;
  }
}
function ownProcessStart() {
  return readProcessStart(process.pid) ?? null;
}
function comparableProcessStart(processStart) {
  if (process.platform === "linux") return /^\d+$/u.test(processStart);
  if (process.platform === "darwin") return processStart.startsWith("ps:") && processStart.length > 3;
  return false;
}
function processLiveness(pid, processStart, tokenLive) {
  if (pid === process.pid) {
    if (tokenLive) return "live";
    if (processStart !== null && comparableProcessStart(processStart)) {
      const ownStart = readProcessStart(process.pid);
      if (ownStart !== void 0 && ownStart !== processStart) return "dead";
    }
    return "live";
  }
  let probe;
  try {
    process.kill(pid, 0);
    probe = "alive";
  } catch (error) {
    const code = errorCode(error);
    probe = code === "ESRCH" ? "gone" : code === "EPERM" ? "alive" : "unknown";
  }
  if (probe === "gone") return "dead";
  if (probe === "unknown") return "ambiguous";
  if (process.platform === "linux") {
    const stat = readLinuxProcess(pid);
    if (stat === void 0) return processStart === null ? "live" : "ambiguous";
    if (stat.state.startsWith("Z") || stat.state === "X") return "dead";
    if (processStart !== null && comparableProcessStart(processStart) && stat.start !== processStart) {
      return "dead";
    }
    return processStart === null || comparableProcessStart(processStart) ? "live" : "ambiguous";
  }
  if (process.platform === "darwin") {
    const start = readProcessStart(pid);
    if (start === void 0) return processStart === null ? "live" : "ambiguous";
    if (processStart === null) return "live";
    if (!comparableProcessStart(processStart)) return "ambiguous";
    return start === processStart ? "live" : "dead";
  }
  return processStart === null ? "live" : "ambiguous";
}
function parseLockOwner(raw, id) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return void 0;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
  const record = value;
  if (record.version !== LOCK_VERSION || record.id !== id) return void 0;
  const { token, pid, startedAt, processStart } = record;
  if (typeof token !== "string" || token === "") return void 0;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || pid > 2147483647) return void 0;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt < 0 || startedAt > MAX_EPOCH_MS) return void 0;
  if (processStart !== null && (typeof processStart !== "string" || !(/^\d+$/.test(processStart) || processStart.startsWith("ps:") && processStart.length > 3))) return void 0;
  return { id, token, pid, startedAt, processStart };
}
function readGenerations(providerDir, id) {
  let names;
  try {
    names = readdirSync(providerDir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    return [{ path: providerDir, generation: 0, status: "unverifiable", reason: `cannot be listed (${errorMessage(error)})` }];
  }
  const locks = [];
  for (const name2 of names) {
    const match = GENERATION_FILE.exec(name2);
    if (match === null) continue;
    const generation = Number(match[1]);
    if (!Number.isSafeInteger(generation)) continue;
    const path = join(providerDir, name2);
    let raw;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      locks.push({ path, generation, status: "unverifiable", reason: `cannot be read (${errorMessage(error)})` });
      continue;
    }
    const owner = parseLockOwner(raw, id);
    if (owner === void 0) {
      locks.push({ path, generation, status: "unverifiable", reason: "is malformed or names a different provider" });
      continue;
    }
    const liveness = processLiveness(owner.pid, owner.processStart, liveTokens.has(owner.token));
    if (liveness === "live") {
      locks.push({ path, generation, status: "held", parsed: { owner } });
    } else if (liveness === "dead") {
      locks.push({ path, generation, status: "dead", parsed: { owner } });
    } else {
      locks.push({
        path,
        generation,
        status: "unverifiable",
        reason: `names pid ${String(owner.pid)}, whose liveness cannot be verified`
      });
    }
  }
  locks.sort((left, right) => left.generation - right.generation);
  return locks;
}
function inspectProviderLock(jobDir, id) {
  const locks = readGenerations(lockDirectory(jobDir, id), id);
  const highest = locks.at(-1);
  if (highest === void 0) return { kind: "none" };
  if (highest.status === "held" && highest.parsed !== void 0) {
    return { kind: "held", path: highest.path, owner: highest.parsed.owner };
  }
  if (highest.status === "dead") return { kind: "dead", path: highest.path };
  return { kind: "unverifiable", path: highest.path, reason: highest.reason ?? "cannot be verified" };
}
function removeDeadGenerations(locks, ownedPath) {
  for (const lock of locks) {
    if (lock.status !== "dead" || lock.path === ownedPath) continue;
    try {
      unlinkSync(lock.path);
    } catch {
    }
  }
}
var HeavyProviderLock = class {
  /**
   * @param path - the owned generation's file.
   * @param owner - the recorded identity.
   * @param content - the exact serialized record release compares against.
   */
  constructor(path, owner, content) {
    this.path = path;
    this.owner = owner;
    this.content = content;
  }
  released = false;
  /**
   * Remove this lock only when the generation still carries this exact
   * record. A replaced record belongs to another owner and is left in place.
   * Idempotent.
   */
  release() {
    if (this.released) return;
    this.released = true;
    try {
      if (readFileSync(this.path, "utf8") === this.content) unlinkSync(this.path);
    } catch {
    } finally {
      liveTokens.delete(this.owner.token);
    }
  }
};
function acquireProviderLock(jobDir, id, now = Date.now) {
  const providerDir = lockDirectory(jobDir, id);
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      mkdirSync(providerDir, { recursive: true, mode: 448 });
    } catch (error) {
      throw new HeavyProviderLockUnreadableError(providerDir, `cannot be created (${errorMessage(error)})`);
    }
    const existing = readGenerations(providerDir, id);
    const highest = existing.at(-1);
    let generation = 1;
    if (highest !== void 0) {
      if (highest.status === "held" && highest.parsed !== void 0) {
        throw new HeavyProviderLockedError(highest.path, highest.parsed.owner);
      }
      if (highest.status === "unverifiable") {
        throw new HeavyProviderLockUnreadableError(highest.path, highest.reason ?? "cannot be verified");
      }
      if (highest.generation >= MAX_GENERATION) {
        throw new HeavyProviderLockUnreadableError(highest.path, "exhausted the generation name space");
      }
      generation = highest.generation + 1;
    }
    const owner = {
      id,
      token: randomUUID(),
      pid: process.pid,
      startedAt: now(),
      processStart: ownProcessStart()
    };
    const content = JSON.stringify({ version: LOCK_VERSION, ...owner });
    const path = join(providerDir, `${String(generation).padStart(12, "0")}.lock`);
    const temporary = `${path}.tmp-${String(process.pid)}-${createHash("sha256").update(owner.token).digest("hex").slice(0, 12)}`;
    try {
      writeFileSync(temporary, content, { encoding: "utf8", mode: 384, flag: "wx" });
      try {
        linkSync(temporary, path);
      } catch (error) {
        if (errorCode(error) === "EEXIST") continue;
        throw new HeavyProviderLockUnreadableError(path, `cannot be created (${errorMessage(error)})`);
      }
    } catch (error) {
      if (error instanceof HeavyProviderLockUnreadableError) throw error;
      throw new HeavyProviderLockUnreadableError(path, `cannot be written (${errorMessage(error)})`);
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
      }
    }
    liveTokens.set(owner.token, owner);
    removeDeadGenerations(existing, path);
    return new HeavyProviderLock(path, owner, content);
  }
  throw new HeavyProviderLockedError(providerDir);
}

// src/jobs.ts
var LOG_CAP_BYTES = 8192;
var HeavyJobManager = class {
  jobs = /* @__PURE__ */ new Map();
  running = /* @__PURE__ */ new Set();
  /** Provider ids currently covered by {@link withProviderLock}. */
  exclusive = /* @__PURE__ */ new Set();
  dir;
  run;
  now;
  /**
   * @param options - cache directory, step runner, and a clock seam for tests.
   */
  constructor(options) {
    this.dir = options.dir;
    this.run = options.run;
    this.now = options.now ?? Date.now;
    this.recoverInterrupted();
  }
  /**
   * A job persisted as `running` without a live lock owner belongs to a
   * previous process: the runner died with it, so the file is rewritten as
   * failed instead of leaving the UI polling a job nothing will ever finish.
   * A live owner, or a lock whose holder cannot be proven dead, keeps its
   * `running` file untouched.
   */
  recoverInterrupted() {
    try {
      readdirSync2(this.dir).filter((name2) => name2.endsWith(".json")).forEach((name2) => {
        const path = join2(this.dir, name2);
        try {
          const view = JSON.parse(readFileSync2(path, "utf8"));
          if (view?.state !== "running" || typeof view.id !== "string") return;
          const ownership = inspectProviderLock(this.dir, view.id);
          if (ownership.kind === "held" || ownership.kind === "unverifiable") return;
          view.state = "failed";
          view.error = "interrupted by harness restart";
          view.finishedAt = this.now();
          this.persist(view);
        } catch {
        }
      });
    } catch {
    }
  }
  /**
   * Start a job unless the provider is already owned. Ownership is taken
   * before the initial snapshot is written and held through the finalizer and
   * the terminal persist. A live owner elsewhere returns its snapshot (when
   * one is readable) or a failed refusal view; a lock that cannot be proven
   * dead throws `HeavyProviderLockUnreadableError` instead of guessing.
   * The returned view is the initial snapshot; `finalize` runs only after all
   * required steps succeed, and its failure marks the job failed.
   * @param id - provider id (the job file name).
   * @param kind - install or teardown.
   * @param steps - declared steps in order.
   * @param finalize - success action (route write); absent means none.
   * @returns the initial job snapshot.
   */
  start(id, kind, steps, finalize) {
    if (this.running.has(id)) return this.snapshot(id) ?? failed(id, "job already running");
    let lock;
    try {
      lock = acquireProviderLock(this.dir, id, this.now);
    } catch (error) {
      if (!(error instanceof HeavyProviderLockedError)) throw error;
      const current = this.snapshot(id);
      return current?.state === "running" ? current : failed(id, error.message);
    }
    try {
      const total = steps.reduce((sum, step) => sum + (step.weight ?? 1), 0);
      const view = {
        id,
        kind,
        state: "running",
        stage: steps[0]?.label ?? "Finishing",
        stageIndex: 0,
        stageCount: steps.length,
        pct: 0,
        logTail: "",
        startedAt: this.now()
      };
      this.jobs.set(id, view);
      this.running.add(id);
      this.persist(view);
      void this.runAll(view, steps, total, lock, finalize);
      return { ...view };
    } catch (error) {
      this.running.delete(id);
      this.jobs.delete(id);
      lock.release();
      throw error;
    }
  }
  /** The latest snapshot: in-memory first, then the persisted file (survives a restart). */
  snapshot(id) {
    const memory = this.jobs.get(id);
    if (memory !== void 0) return { ...memory };
    try {
      const raw = JSON.parse(readFileSync2(join2(this.dir, `${id}.json`), "utf8"));
      return raw !== null && typeof raw === "object" ? raw : void 0;
    } catch {
      return void 0;
    }
  }
  /**
   * Whether this provider is owned by a running job: this manager's own job,
   * or a live owner in another manager or process. An unverifiable lock is
   * reported as running so callers fail closed and never evict its files.
   * @param id - provider id.
   * @returns true while the provider's install/teardown must not be evicted.
   */
  isRunning(id) {
    if (this.running.has(id)) return true;
    if (this.exclusive.has(id)) return false;
    const ownership = inspectProviderLock(this.dir, id);
    return ownership.kind === "held" || ownership.kind === "unverifiable";
  }
  /**
   * Evict one provider's snapshot: the in-memory view and its persisted file.
   * A removed provider's terminal job must not resurrect on the next status
   * poll. Eviction owns the provider lock while it removes the file, so a
   * concurrent `start` either loses to a live eviction or runs after it. A
   * running job — including one owned by another manager or process — keeps
   * both the snapshot and its file; a lock that cannot be proven dead also
   * refuses eviction.
   * @param id - provider id.
   * @returns true when the snapshot and file were removed, false when a live
   * or unverifiable owner refused the eviction.
   */
  evict(id) {
    if (this.running.has(id)) return false;
    if (this.exclusive.has(id)) {
      this.removeSnapshot(id);
      return true;
    }
    let lock;
    try {
      lock = acquireProviderLock(this.dir, id, this.now);
    } catch (error) {
      if (error instanceof HeavyProviderLockedError || error instanceof HeavyProviderLockUnreadableError) return false;
      throw error;
    }
    try {
      this.removeSnapshot(id);
      return true;
    } finally {
      lock.release();
    }
  }
  /**
   * Run one provider-scoped operation under the same exclusive lock an
   * install owns. Removal uses this so route, credential, pool, and cache
   * cleanup cannot overlap a live install; `evict` is permitted inside the
   * operation. A live owner refuses with {@link HeavyProviderLockedError}; an
   * unverifiable record fails closed with `HeavyProviderLockUnreadableError`.
   * @param id - provider id.
   * @param operation - async work to run while holding the lock.
   * @returns the operation's result.
   */
  async withProviderLock(id, operation) {
    const lock = acquireProviderLock(this.dir, id, this.now);
    this.exclusive.add(id);
    try {
      return await operation();
    } finally {
      this.exclusive.delete(id);
      lock.release();
    }
  }
  /** Drop the in-memory view and the persisted snapshot; callers own the lock. */
  removeSnapshot(id) {
    this.jobs.delete(id);
    try {
      rmSync(join2(this.dir, `${id}.json`), { force: true });
    } catch {
    }
  }
  appendLog(view, chunk) {
    view.logTail = `${view.logTail}${chunk}`.slice(-LOG_CAP_BYTES);
  }
  persist(view) {
    try {
      mkdirSync2(this.dir, { recursive: true });
      const path = join2(this.dir, `${view.id}.json`);
      const temporary = `${path}.tmp-${String(process.pid)}`;
      writeFileSync2(temporary, JSON.stringify(view), "utf8");
      renameSync(temporary, path);
    } catch {
    }
  }
  async runAll(view, steps, total, lock, finalize) {
    try {
      let done = 0;
      for (const [index, step] of steps.entries()) {
        view.stage = step.label;
        view.stageIndex = index;
        this.persist(view);
        let outcome;
        try {
          outcome = await this.run(step);
        } catch (error) {
          if (step.optional === true) {
            this.appendLog(view, `$ ${step.label}: optional step failed \u2014 ${error instanceof Error ? error.message : String(error)}
`);
            done += step.weight ?? 1;
            view.pct = Math.min(99, Math.round(done / total * 99));
            continue;
          }
          this.fail(view, `${step.label}: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        this.appendLog(view, `$ ${step.label}
${outcome.output}
`);
        if (outcome.exitCode !== 0) {
          if (step.optional === true) {
            this.appendLog(view, `$ ${step.label}: optional step exited ${String(outcome.exitCode)}
`);
          } else {
            this.fail(view, `${step.label}: exit ${String(outcome.exitCode)}`);
            return;
          }
        }
        done += step.weight ?? 1;
        view.pct = Math.min(99, Math.round(done / total * 99));
        this.persist(view);
      }
      view.stage = "Finishing";
      this.persist(view);
      try {
        await finalize?.();
      } catch (error) {
        this.fail(view, error instanceof Error ? error.message : String(error));
        return;
      }
      view.state = "succeeded";
      view.pct = 100;
      view.finishedAt = this.now();
      this.running.delete(view.id);
      this.persist(view);
    } finally {
      lock.release();
    }
  }
  fail(view, error) {
    view.state = "failed";
    view.error = error;
    view.finishedAt = this.now();
    this.running.delete(view.id);
    this.persist(view);
  }
};
function failed(id, error) {
  return {
    id,
    kind: "install",
    state: "failed",
    stage: "rejected",
    stageIndex: 0,
    stageCount: 0,
    pct: 0,
    logTail: "",
    startedAt: 0,
    finishedAt: 0,
    error
  };
}
function visibleJobSnapshot(job, configured) {
  return job !== void 0 && job.state === "succeeded" && configured ? void 0 : job;
}

// src/manifests.ts
import { offeredCompatFields } from "@deepseek-ai/dsh-llm-pi-ai";
function platformInstallVariant(local, platform) {
  return platform === "linux" || platform === "darwin" || platform === "win32" ? local.install[platform] ?? local.install.default : local.install.default;
}
function platformUnsupported(manifest, platform) {
  return platformInstallVariant(manifest.local, platform).unsupported;
}
function resolveHeavyInstall(local, platform) {
  const variant = platformInstallVariant(local, platform);
  return {
    label: variant.label ?? local.label,
    deps: variant.deps ?? local.deps,
    diskHint: variant.diskHint ?? local.diskHint,
    steps: variant.steps
  };
}
var HEAVY_ENV = {
  /** User home directory. */
  home: "DSH_HEAVY_HOME",
  /** DSH home directory. */
  dshHome: "DSH_HEAVY_DSH_HOME",
  /** Running profile root; empty when no launcher supplied one. */
  profileDir: "DSH_HEAVY_PROFILE_DIR",
  /** Absolute path of this package's installer helper. */
  helper: "DSH_HEAVY_HELPER"
};
var RELEASE_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
function parseReleaseSource(value) {
  const trimmed = value.trim();
  if (trimmed === "" || /\s|\u0000/u.test(trimmed)) return void 0;
  if (RELEASE_REPO_RE.test(trimmed)) return { kind: "repo", value: trimmed };
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return void 0;
  }
  if (url.protocol !== "https:") return void 0;
  if (url.username !== "" || url.password !== "") return void 0;
  if (url.hash !== "") return void 0;
  return { kind: "api", value: url.href };
}
function releaseSourceArguments(source) {
  if (source === void 0) return [];
  const parsed = parseReleaseSource(source);
  if (parsed === void 0) return [];
  return parsed.kind === "api" ? ["--releases-api", parsed.value] : ["--repo", parsed.value];
}
function shellQuoteArgument(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function withReleaseSource(steps, source) {
  const args = releaseSourceArguments(source);
  if (args.length === 0) return steps;
  const suffix = args.map((arg, index) => index % 2 === 0 ? arg : shellQuoteArgument(arg)).join(" ");
  return steps.map((step) => step.command.includes("$DSH_HEAVY_HELPER") ? { ...step, command: `${step.command} ${suffix}` } : step);
}
var LLM_PI_AI_PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages"];
var RUNTIME_TOOL_RE = {
  docker: /\bdocker(?:-compose|\s+compose)?\b/,
  podman: /\bpodman\b/,
  node: /\b(?:node|npm|npx|pnpm|yarn)\b/
};
var FREELLMAPI_RELEASES_API = "https://api.github.com/repos/tashfeenahmed/freellmapi/releases/latest";
var ANTIGRAVITY_LAUNCHD_LABEL = "dev.enpoi.antigravity-proxy";
var ANTIGRAVITY_PACKAGE = "antigravity-claude-proxy";
var ANTIGRAVITY_NPM_STEP = {
  label: "Install the proxy package",
  command: `mkdir -p "{home}/.local/bin" && npm install -g --prefix "{home}/.local" ${ANTIGRAVITY_PACKAGE}`,
  weight: 2
};
var ANTIGRAVITY_WAIT_STEP = {
  label: "Wait for the proxy",
  command: 'for i in {1..30}; do curl -fsS http://127.0.0.1:8082/health >/dev/null && exit 0; sleep 2; done; echo "proxy did not answer within 60s"; exit 1'
};
var ANTIGRAVITY_SYSTEMD_STEPS = [
  ANTIGRAVITY_NPM_STEP,
  {
    label: "Write the systemd user unit",
    // `start --log` is the package's foreground mode; a bare invocation only
    // prints help. The unit's main process must stay the server. The explicit
    // PATH resolves the npm shim's `node` when the version manager only
    // extends an interactive shell; the wrapper prefers the absolute path the
    // npm step guarantees and falls back to the PATH-resolved binary (a
    // version-managed node shim may live outside `~/.local/bin`).
    command: `mkdir -p {config}/systemd/user && cat > {config}/systemd/user/antigravity-proxy.service <<'EOF'
[Unit]
Description=Antigravity Claude proxy (per-device)
After=network-online.target

[Service]
Environment=PORT=8082
Environment=HOST=127.0.0.1
Environment=PATH={home}/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/bin/bash -lc 'BIN="{home}/.local/bin/antigravity-claude-proxy"; test -x "$BIN" || BIN="$(command -v antigravity-claude-proxy)"; exec "$BIN" start --log'
Restart=on-failure

[Install]
WantedBy=default.target
EOF`
  },
  { label: "Enable and start the unit", command: "systemctl --user daemon-reload && systemctl --user enable --now antigravity-proxy.service" },
  {
    label: "Enable lingering (the unit starts without an open login session)",
    command: 'loginctl enable-linger "$(id -un)"',
    optional: true
  },
  ANTIGRAVITY_WAIT_STEP
];
var ANTIGRAVITY_LAUNCHD_STEPS = [
  ANTIGRAVITY_NPM_STEP,
  {
    label: "Write the launchd agent",
    command: `mkdir -p {home}/Library/LaunchAgents {home}/Library/Logs && cat > {home}/Library/LaunchAgents/${ANTIGRAVITY_LAUNCHD_LABEL}.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${ANTIGRAVITY_LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>BIN="{home}/.local/bin/antigravity-claude-proxy"; test -x "$BIN" || BIN="$(command -v antigravity-claude-proxy)"; exec "$BIN" start --log</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>8082</string>
    <key>HOST</key>
    <string>127.0.0.1</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:{home}/.local/bin:{home}/.nvm/versions/node/current/bin:{home}/Library/Application Support/fnm/aliases/default/bin:{home}/.local/share/fnm/aliases/default/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>{home}/Library/Logs/antigravity-proxy.log</string>
  <key>StandardErrorPath</key>
  <string>{home}/Library/Logs/antigravity-proxy.err.log</string>
</dict>
</plist>
EOF`
  },
  {
    label: "Load and start the agent",
    command: `launchctl bootout gui/$(id -u)/${ANTIGRAVITY_LAUNCHD_LABEL} 2>/dev/null || true; launchctl bootstrap gui/$(id -u) {home}/Library/LaunchAgents/${ANTIGRAVITY_LAUNCHD_LABEL}.plist 2>/dev/null || launchctl load -w {home}/Library/LaunchAgents/${ANTIGRAVITY_LAUNCHD_LABEL}.plist`
  },
  ANTIGRAVITY_WAIT_STEP
];
var ANTIGRAVITY_PREFIX_SWEEP_COMMAND = `PKG=${ANTIGRAVITY_PACKAGE}; strip_prefix() { p="$1"; [ -n "$p" ] || return 0; if command -v npm >/dev/null 2>&1; then npm uninstall -g --prefix "$p" "$PKG" >/dev/null 2>&1 || true; fi; rm -rf "$p/lib/node_modules/$PKG" "$p/bin/$PKG" 2>/dev/null || true; if [ -L "$p/bin/acc" ]; then case "$(readlink "$p/bin/acc" 2>/dev/null)" in *"$PKG"*) rm -f "$p/bin/acc" 2>/dev/null || true;; esac; fi; for stage in "$p"/lib/node_modules/."$PKG"-*; do if [ -e "$stage" ]; then rm -rf "$stage" 2>/dev/null || true; fi; done; if [ -d "$p/lib/node_modules/$PKG" ] || [ -e "$p/bin/$PKG" ]; then echo "warning: $p still holds $PKG; remove it manually (system prefixes may need sudo): rm -rf $p/lib/node_modules/$PKG $p/bin/$PKG $p/bin/acc"; fi; }; strip_prefix "{home}/.local"; strip_prefix "{home}/.npm-global"; if command -v npm >/dev/null 2>&1; then strip_prefix "$(npm prefix -g 2>/dev/null)"; fi; for prefix in "{home}/.nvm/versions/node"/* "{home}/.local/share/nvm/versions/node"/* "{home}/.local/share/fnm/aliases/default" "{home}/Library/Application Support/fnm/aliases/default" "/opt/homebrew"; do if [ -d "$prefix" ]; then strip_prefix "$prefix"; fi; done; for prefix in "/usr/local" "/usr"; do if [ -d "$prefix/lib/node_modules/$PKG" ] || [ -e "$prefix/bin/$PKG" ]; then strip_prefix "$prefix"; fi; done; exit 0`;
var COMMANDCODE_HEALTH = {
  url: "https://api.commandcode.ai/",
  timeoutMs: 5e3,
  expectStatus: [200, 401, 403, 404, 405],
  headers: {
    "x-command-code-version": "1.54.0",
    "x-cli-environment": "production",
    "x-project-slug": "opencode",
    "user-agent": "cli"
  }
};
var COMMANDCODE_INSTALL_STEP = {
  label: "Link and build the DSH provider package",
  command: 'node "$DSH_HEAVY_PROFILE_DIR/packages/enpoi-commandcode-provider/scripts/install.mjs" "$DSH_HEAVY_PROFILE_DIR"',
  weight: 3
};
var MERIDIAN_PORT = 3456;
var MERIDIAN_LAUNCHD_LABEL = "dev.meridian.proxy";
var MERIDIAN_CLAUDE_CLI_PACKAGE = "@anthropic-ai/claude-code";
var MERIDIAN_PACKAGE = "@rynfar/meridian";
var MERIDIAN_HEALTH = { url: `http://127.0.0.1:${MERIDIAN_PORT}/health`, timeoutMs: 5e3 };
var MERIDIAN_NODE_STEP = {
  label: "Check Node.js and npm",
  command: `command -v node >/dev/null && command -v npm >/dev/null || { echo "Meridian needs Node.js >= 22 with npm on PATH"; exit 1; }; major="$(node -p 'process.versions.node.split(".")[0]')"; [ "$major" -ge 22 ] || { echo "Meridian needs Node.js >= 22 (found $(node -v))"; exit 1; }`
};
var MERIDIAN_CLI_STEP = {
  label: "Install the Claude Code CLI when it is missing or older than 2.1.293",
  command: `GLOBAL_BIN="$(npm prefix -g)/bin" && export PATH="$GLOBAL_BIN:$PATH"; have="$(claude --version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -1)"; if [ -n "$have" ] && node -e 'const [a,b,c]=process.argv[1].split(".").map(Number); process.exit(a>2||(a===2&&(b>1||(b===1&&c>=293)))?0:1)' "$have"; then echo "Claude Code CLI $have is installed"; else npm install -g ${MERIDIAN_CLAUDE_CLI_PACKAGE}; fi`,
  weight: 2
};
var MERIDIAN_LOGIN_STEP = {
  label: "Require a Claude subscription login",
  command: `GLOBAL_BIN="$(npm prefix -g)/bin" && export PATH="$GLOBAL_BIN:$PATH"; env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN claude auth status 2>/dev/null | grep -q '"claude.ai"' || { echo "the Claude Code CLI is not signed in to a Claude subscription"; echo "run: env -u ANTHROPIC_API_KEY claude auth login --claudeai"; echo "then re-run this install"; exit 1; }`,
  weight: 2
};
var MERIDIAN_INSTALL_STEP = {
  label: "Install Meridian",
  command: `npm install -g ${MERIDIAN_PACKAGE}@latest`,
  weight: 2
};
var MERIDIAN_SYSTEMD_UNIT_STEP = {
  label: "Write the systemd user unit",
  command: `mkdir -p {config}/systemd/user && NODE_BIN="$(command -v node)" && GLOBAL_BIN="$(npm prefix -g)/bin" && ENTRY="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$(npm root -g)/${MERIDIAN_PACKAGE}/dist/cli.js")" || { echo "could not resolve ${MERIDIAN_PACKAGE}/dist/cli.js under $(npm root -g 2>/dev/null); run the Meridian install step first"; exit 1; }; cat > {config}/systemd/user/meridian.service <<EOF
[Unit]
Description=Meridian \u2014 standalone API bridge for the Claude subscription (official Agent SDK)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# node plus the resolved cli.js: the bin's #!/usr/bin/env node shebang does not resolve here
ExecStart=$NODE_BIN $ENTRY
Restart=on-failure
RestartSec=10s
StandardOutput=journal
StandardError=journal
Environment=HOME=%h
Environment=MERIDIAN_HOST=127.0.0.1
Environment=MERIDIAN_PORT=${MERIDIAN_PORT}
Environment=MERIDIAN_PASSTHROUGH=1
Environment=MERIDIAN_ENFORCE_MAX_TOKENS=1
# the Agent SDK spawns claude, which lives in the npm global bin
Environment=PATH=$GLOBAL_BIN:{home}/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF`
};
var MERIDIAN_SYSTEMD_ENABLE_STEP = {
  label: "Enable and start the unit",
  command: "systemctl --user daemon-reload && systemctl --user enable --now meridian.service"
};
var MERIDIAN_LAUNCHD_WRITE_STEP = {
  label: "Write the launchd agent",
  command: `mkdir -p {home}/Library/LaunchAgents {home}/Library/Logs && NODE_BIN="$(command -v node)" && GLOBAL_BIN="$(npm prefix -g)/bin" && ENTRY="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$(npm root -g)/${MERIDIAN_PACKAGE}/dist/cli.js")" || { echo "could not resolve ${MERIDIAN_PACKAGE}/dist/cli.js under $(npm root -g 2>/dev/null); run the Meridian install step first"; exit 1; }; cat > {home}/Library/LaunchAgents/${MERIDIAN_LAUNCHD_LABEL}.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MERIDIAN_LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ENTRY</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>{home}</string>
    <key>MERIDIAN_HOST</key>
    <string>127.0.0.1</string>
    <key>MERIDIAN_PORT</key>
    <string>${MERIDIAN_PORT}</string>
    <key>MERIDIAN_PASSTHROUGH</key>
    <string>1</string>
    <key>MERIDIAN_ENFORCE_MAX_TOKENS</key>
    <string>1</string>
    <key>PATH</key>
    <string>$GLOBAL_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{home}/Library/Logs/meridian.log</string>
  <key>StandardErrorPath</key>
  <string>{home}/Library/Logs/meridian.err.log</string>
</dict>
</plist>
EOF`
};
var MERIDIAN_LAUNCHD_LOAD_STEP = {
  label: "Load and start the agent",
  command: `launchctl bootout gui/$(id -u)/${MERIDIAN_LAUNCHD_LABEL} 2>/dev/null || true; launchctl bootstrap gui/$(id -u) {home}/Library/LaunchAgents/${MERIDIAN_LAUNCHD_LABEL}.plist 2>/dev/null || launchctl load -w {home}/Library/LaunchAgents/${MERIDIAN_LAUNCHD_LABEL}.plist; launchctl kickstart -k gui/$(id -u)/${MERIDIAN_LAUNCHD_LABEL}`
};
var MERIDIAN_WAIT_STEP = {
  label: "Wait for Meridian",
  command: `for i in {1..30}; do curl -fsS http://127.0.0.1:${MERIDIAN_PORT}/health >/dev/null && exit 0; sleep 2; done; echo "Meridian did not answer /health within 60s \u2014 check the user service log (systemctl --user status meridian.service, or launchctl print gui/$(id -u)/dev.meridian.proxy)"; exit 1`
};
var MERIDIAN_SYSTEMD_STEPS = [
  MERIDIAN_NODE_STEP,
  MERIDIAN_CLI_STEP,
  MERIDIAN_LOGIN_STEP,
  MERIDIAN_INSTALL_STEP,
  MERIDIAN_SYSTEMD_UNIT_STEP,
  MERIDIAN_SYSTEMD_ENABLE_STEP,
  MERIDIAN_WAIT_STEP
];
var MERIDIAN_LAUNCHD_STEPS = [
  MERIDIAN_NODE_STEP,
  MERIDIAN_CLI_STEP,
  MERIDIAN_LOGIN_STEP,
  MERIDIAN_INSTALL_STEP,
  MERIDIAN_LAUNCHD_WRITE_STEP,
  MERIDIAN_LAUNCHD_LOAD_STEP,
  MERIDIAN_WAIT_STEP
];
var CLIPROXYAPI_PORT = 8317;
var CLIPROXYAPI_DOCS_URL = "https://help.router-for.me/";
var CLIPROXYAPI_HELPER_ENV = "$DSH_HEAVY_HELPER";
var CLIPROXYAPI_HELPER_FILE = {
  paths: ["{helper}"],
  hint: "The CLIProxyAPI installer helper (scripts/cliproxyapi-install.mjs) is missing from this plugin package \u2014 reinstall the profile plugin or use a detected instance"
};
var CLIPROXYAPI_INSTALL_STEP = {
  label: "Install CLIProxyAPI (verified release and user service)",
  command: `node "${CLIPROXYAPI_HELPER_ENV}" install --dsh-home "$DSH_HEAVY_DSH_HOME"`,
  weight: 3
};
var CLIPROXYAPI_REMOVE_STEP = {
  label: "Remove the CLIProxyAPI install (stop the service and remove verified files)",
  command: `node "${CLIPROXYAPI_HELPER_ENV}" remove --dsh-home "$DSH_HEAVY_DSH_HOME"`,
  weight: 2
};
var CLIPROXYAPI_HEALTH = {
  url: `http://127.0.0.1:${CLIPROXYAPI_PORT}/healthz`,
  timeoutMs: 5e3
};
var HEAVY_MANIFESTS = [
  {
    id: "freellmapi",
    label: "FreeLLMAPI",
    summary: "Self-hosted free-tier gateway: ~30 providers behind one OpenAI-compatible endpoint.",
    protocol: "openai-completions",
    auth: { kind: "unified", apiKeyEnv: "FREELLMAPI_API_KEY", keyless: false },
    dashboardUrl: "http://127.0.0.1:3002",
    docsUrl: "https://freellmapi.co",
    releasesApi: FREELLMAPI_RELEASES_API,
    defaultPort: 3002,
    // Browser badges belong only to account flows that cannot complete without
    // a browser (antigravity's Google OAuth); FreeLLMAPI's dashboard steps are
    // ordinary quirks, not an operator-blocking browser requirement.
    requiresBrowser: [],
    quirks: [
      "Local install dependencies: Linux uses Docker/Podman compose; macOS/Windows use the vendor desktop app (no Docker needed there)",
      "First-run setup code and password-reset code appear only in `docker compose logs`; upstream provider keys are added on the web dashboard",
      "Unified key is the only client auth \u2014 never expose this port beyond the local machine",
      "Losing ENCRYPTION_KEY (in ~/freellmapi/.env) makes every stored upstream key unrecoverable",
      "The free-tier catalog is a monthly snapshot; /v1/models can list models no key serves",
      "A missing bind-mounted JSON file is created as a directory by Docker \u2192 boot loop",
      "Windows: the desktop-app install steps run through Git Bash (the harness executes shell steps with bash) \u2014 install Git for Windows first"
    ],
    reuse: {
      label: "Use a detected instance",
      baseURL: "http://127.0.0.1:3002/v1",
      note: "Zero install: uses a FreeLLMAPI instance already running on this device.",
      health: { url: "http://127.0.0.1:3002/api/ping", timeoutMs: 5e3 }
    },
    local: {
      label: "Install locally (Docker or Podman)",
      baseURL: "http://127.0.0.1:3002/v1",
      deps: ["Docker Engine or Podman, with Compose"],
      diskHint: "~700 MB disk (536 MB image), ~84 MB RAM idle, no GPU",
      dashboardUrl: "http://127.0.0.1:3002",
      runtime: "docker",
      install: {
        // Unknown platforms fall back to the manual Docker Compose path.
        default: {
          steps: [
            // Re-running the install must not fail on the existing clone. A
            // stale non-git directory is replaced, but a `.env` inside it is
            // never wiped: it holds ENCRYPTION_KEY, and deleting it makes
            // every stored upstream key unrecoverable.
            { label: "Clone FreeLLMAPI", command: 'if [ -d "{home}/freellmapi" ] && [ ! -d "{home}/freellmapi/.git" ]; then if [ -f "{home}/freellmapi/.env" ]; then echo "Existing {home}/freellmapi/.env found without .git; refusing to wipe it \u2014 move the directory aside, then retry" >&2; exit 1; fi; rm -rf "{home}/freellmapi" 2>/dev/null || true; fi; test -d "{home}/freellmapi/.git" || git clone --depth 1 https://github.com/tashfeenahmed/freellmapi "{home}/freellmapi"', weight: 2 },
            {
              label: "Generate ENCRYPTION_KEY",
              // PORT is the HOST port (compose maps ${PORT}:3001); keep it at
              // 3002 so the local route's baseURL resolves. An existing .env
              // is kept only when its ENCRYPTION_KEY is non-empty: an empty
              // key makes every stored upstream key unrecoverable.
              command: `if [ ! -f "{home}/freellmapi/.env" ] || ! grep -qE '^ENCRYPTION_KEY=.+' "{home}/freellmapi/.env"; then printf "ENCRYPTION_KEY=%s\\nPORT=3002\\nHOST_BIND=127.0.0.1\\n" "$(openssl rand -hex 32)" > "{home}/freellmapi/.env"; fi`
            },
            {
              label: "Start the stack",
              // Docker or Podman: preflight offers Podman as the substitute,
              // so the step must resolve whichever engine exists. A Podman
              // without its compose plugin has to fail here, not midway
              // through `up`.
              command: 'ENGINE="$(command -v docker || command -v podman)"; test -n "$ENGINE" || { echo "neither docker nor podman is installed"; exit 1; }; "$ENGINE" compose version >/dev/null 2>&1 || { echo "podman compose plugin missing (need podman-compose)"; exit 1; }; "$ENGINE" compose up -d',
              cwd: "{home}/freellmapi"
            },
            {
              label: "Wait for the gateway",
              command: 'for i in {1..60}; do curl -fsS http://127.0.0.1:3002/api/ping >/dev/null && exit 0; sleep 2; done; echo "gateway did not answer within 120s"; exit 1'
            }
          ]
        },
        // No linux override: the vendor one-liner is Docker-only, while
        // preflight accepts Podman as the substitute runtime, so Linux uses
        // the same engine-aware compose path as every other platform.
        // macOS prefers the vendor desktop app: no Docker Desktop overhead.
        darwin: {
          label: "Install locally (vendor desktop app, no Docker)",
          deps: ["macOS 11+"],
          diskHint: "~250 MB app; data in ~/Library/Application Support/FreeLLMAPI",
          runtime: "vendor-app",
          steps: [
            {
              label: "Download the latest .dmg",
              // Apple Silicon and Intel ship separate disk images; picking by
              // `uname -m` keeps the install correct on both. The asset name
              // ends `-<arch>.dmg`, so the pattern must carry that hyphen (a
              // `"arm64` pattern can never match). A re-run keeps the image
              // already in ~/Downloads.
              command: 'arch="$(uname -m)"; test "$arch" = arm64 || arch=x64; url="$(curl -fsSL ' + FREELLMAPI_RELEASES_API + ` | grep -oE '"browser_download_url": *"[^"]+-'"$arch"'\\.dmg"' | head -1 | cut -d'"' -f4)"; test -n "$url" || { echo "no FreeLLMAPI $arch .dmg in the latest release"; exit 1; }; mkdir -p "{home}/Downloads"; test -f "{home}/Downloads/FreeLLMAPI.dmg" || curl -fsSL -o "{home}/Downloads/FreeLLMAPI.dmg" "$url"`,
              weight: 2
            },
            {
              label: "Install the app from the disk image",
              // A per-run mount point is detached and removed even when the
              // copy fails, so a hung volume never blocks the next attempt.
              command: 'MOUNT="/tmp/freellmapi-dmg-$$"; mkdir -p "$MOUNT"; hdiutil attach "{home}/Downloads/FreeLLMAPI.dmg" -nobrowse -quiet -mountpoint "$MOUNT" && cp -R "$MOUNT"/*.app /Applications/; status=$?; hdiutil detach "$MOUNT" -quiet >/dev/null 2>&1 || true; rmdir "$MOUNT" 2>/dev/null || true; exit $status'
            },
            {
              label: "Pin the desktop app to port 3002",
              command: `mkdir -p "{home}/Library/Application Support/FreeLLMAPI" && printf '{"port":3002}\\n' > "{home}/Library/Application Support/FreeLLMAPI/config.json"`
            },
            { label: "Launch FreeLLMAPI", command: "open -a FreeLLMAPI" },
            {
              label: "Wait for the gateway",
              command: 'for i in {1..60}; do curl -fsS http://127.0.0.1:3002/api/ping >/dev/null && exit 0; sleep 2; done; echo "gateway did not answer within 120s"; exit 1'
            }
          ]
        },
        // Windows only ships a desktop app (no Docker path in the vendor docs).
        win32: {
          label: "Install locally (vendor desktop app, no Docker)",
          deps: ["Windows 10+", "Git Bash (the install steps run through bash)"],
          diskHint: "~250 MB app; data in %APPDATA%\\FreeLLMAPI",
          runtime: "vendor-app",
          steps: [
            {
              label: "Download the latest installer",
              // The matched URL lands in a file first: an empty match has to
              // fail the step instead of feeding xargs an empty string.
              command: 'mkdir -p "{home}/Downloads" && curl -fsSL ' + FREELLMAPI_RELEASES_API + ` | grep -oE '"browser_download_url": *"[^"]+\\.exe"' | head -1 | cut -d'"' -f4 > "{home}/Downloads/freellmapi-setup-url"; test -s "{home}/Downloads/freellmapi-setup-url" || { echo "no .exe in the latest release"; exit 1; }; xargs -I{} curl -fsSL -o "{home}/Downloads/FreeLLMAPI-Setup.exe" {} < "{home}/Downloads/freellmapi-setup-url"`,
              weight: 2
            },
            { label: "Install silently", command: 'cmd //c start //wait "" "$HOME/Downloads/FreeLLMAPI-Setup.exe" /S' },
            {
              label: "Pin the desktop app to port 3002",
              command: `mkdir -p "$APPDATA/FreeLLMAPI" && printf '{"port":3002}\\n' > "$APPDATA/FreeLLMAPI/config.json"`
            },
            { label: "Launch FreeLLMAPI", command: 'cmd //c start "" "$LOCALAPPDATA\\Programs\\FreeLLMAPI\\FreeLLMAPI.exe"' },
            {
              label: "Wait for the gateway",
              command: 'for i in {1..60}; do curl -fsS http://127.0.0.1:3002/api/ping >/dev/null && exit 0; sleep 2; done; echo "gateway did not answer within 120s"; exit 1'
            }
          ]
        }
      },
      health: { url: "http://127.0.0.1:3002/api/ping", timeoutMs: 5e3 }
    },
    removal: {
      steps: [
        // Resolve the engine the same way the install did; every step is
        // fail-soft so a machine that moved to another engine still cleans up.
        { label: "Stop the stack and drop its volume", command: 'ENGINE="$(command -v docker || command -v podman)"; test -n "$ENGINE" && "$ENGINE" compose down -v', cwd: "{home}/freellmapi", optional: true },
        { label: "Remove the container image", command: 'ENGINE="$(command -v docker || command -v podman)"; test -n "$ENGINE" && "$ENGINE" image rm ghcr.io/tashfeenahmed/freellmapi:latest', optional: true },
        { label: "Remove the clone directory", command: 'rm -rf "{home}/freellmapi"' },
        // The vendor desktop-app leftovers are platform-guarded: each step
        // exits cleanly on the platforms it does not own and never fails a
        // teardown.
        {
          label: "Remove the macOS desktop app and its data",
          optional: true,
          command: 'test "$(uname -s)" = Darwin || exit 0; pkill -f FreeLLMAPI 2>/dev/null || true; hdiutil detach "/tmp/freellmapi-dmg" >/dev/null 2>&1 || true; rm -rf /Applications/FreeLLMAPI.app "{home}/Library/Application Support/FreeLLMAPI" "{home}/Downloads/FreeLLMAPI.dmg" /tmp/freellmapi-dmg'
        },
        {
          label: "Remove the Windows desktop app and its data",
          optional: true,
          command: 'case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ;; *) exit 0;; esac; taskkill //F //IM FreeLLMAPI.exe 2>/dev/null || true; rm -rf "$APPDATA/FreeLLMAPI" "$LOCALAPPDATA/Programs/FreeLLMAPI" "$HOME/Downloads/FreeLLMAPI-Setup.exe"'
        }
      ],
      warnings: [
        "`docker compose down -v` deletes volume freellmapi_freellmapi-data \u2014 every upstream key and the unified key die with it",
        "~/freellmapi/.env holds ENCRYPTION_KEY; back it up if the volume data is kept anywhere"
      ]
    },
    fallbackModel: "auto"
  },
  {
    id: "antigravity",
    label: "Antigravity Proxy",
    summary: "Multi-account Anthropic-compatible proxy for Google Antigravity OAuth accounts.",
    protocol: "anthropic-messages",
    // The proxy needs no client key and llm-pi-ai serves keyless anthropic
    // routes, so the route is written keyless; it MUST NOT declare a DSH pool
    // — the proxy runs its own sticky one. Earlier builds staged a non-secret
    // 'placeholder' value under ANTIGRAVITY_API_KEY so discovery could
    // resolve; such a stored value (or a real operator key from the same era)
    // is intentionally left in the credentials store and nothing reads it.
    auth: { kind: "none", keyless: true },
    dashboardUrl: "http://127.0.0.1:8082",
    docsUrl: "https://www.npmjs.com/package/antigravity-claude-proxy",
    defaultPort: 8082,
    requiresBrowser: [
      "Adding a Google account is an OAuth flow that opens a browser and waits on a localhost callback \u2014 on a headless host the printed URL must be opened from a machine that can reach the callback (e.g. over an SSH port-forward); it cannot be automated"
    ],
    quirks: [
      "Local install dependencies: native npm package (Node.js >= 18) behind a systemd or launchd user service on Linux/macOS; Docker is never required. Windows has no supported local install \u2014 run the package manually or use a proxy running elsewhere",
      "Linux: the systemd user unit runs the proxy through /bin/bash -lc with PATH ~/.local/bin:/usr/local/bin:/usr/bin:/bin; the package installs under ~/.local/bin, and a Node.js reachable only from an nvm/fnm shell configuration is not found \u2014 keep it reachable from a login shell or one of those directories",
      "macOS: the launchd agent runs the proxy through /bin/bash -lc with PATH /opt/homebrew/bin:/usr/local/bin:~/.local/bin plus the common nvm/fnm node directories; the package installs under ~/.local/bin, and a Node.js reachable only from a fish/zsh/nvm/fnm shell configuration is not found \u2014 keep it reachable from a login bash profile or one of those directories",
      "The proxy runs its own sticky account pool with cooldowns \u2014 DSH key pooling MUST stay off for this route",
      "The console at :8082 has no auth (webuiPassword empty) \u2014 trusted networks only",
      'Quotas are per-account/per-model weekly windows; "RESOURCE_EXHAUSTED \u2026 resets after 46h" is normal',
      "Other tools on this device may consume the same proxy \u2014 removing the service breaks them too"
    ],
    reuse: {
      label: "Use a detected instance",
      baseURL: "http://127.0.0.1:8082",
      note: "Zero install: uses the proxy instance already running on this device and its configured account pool.",
      health: { url: "http://127.0.0.1:8082/health", timeoutMs: 5e3 }
    },
    local: {
      label: "Install locally (npm + user service)",
      baseURL: "http://127.0.0.1:8082",
      deps: ["Node.js >= 18", "A reachable systemd user session (systemctl --user) on the default path"],
      diskHint: "~23 MB install, ~78\u2013150 MB RAM, no GPU",
      dashboardUrl: "http://127.0.0.1:8082",
      runtime: "node",
      install: {
        // The npm package is cross-platform; the user-service wrapper is not.
        // Linux (and systemd-like hosts) keeps the systemd unit; macOS gets the
        // launchd equivalent; Windows has no POSIX user service to install.
        default: { label: "Install locally (npm + systemd user unit)", steps: ANTIGRAVITY_SYSTEMD_STEPS },
        linux: { label: "Install locally (npm + systemd user unit)", steps: ANTIGRAVITY_SYSTEMD_STEPS },
        darwin: {
          label: "Install locally (npm + launchd agent)",
          deps: ["Node.js >= 18", "macOS 11+ (launchd)"],
          diskHint: "~23 MB install, ~78\u2013150 MB RAM, no GPU; logs in ~/Library/Logs",
          steps: ANTIGRAVITY_LAUNCHD_STEPS
        },
        win32: {
          label: "Not supported on Windows",
          unsupported: "The antigravity proxy local install needs a POSIX user service (systemd or launchd) to keep the proxy running; this profile has no supported Windows provisioning path. Install the npm package and run `antigravity-claude-proxy` yourself, or run the proxy on another machine and add it as a custom route.",
          steps: []
        }
      },
      health: { url: "http://127.0.0.1:8082/health", timeoutMs: 5e3 }
    },
    removal: {
      // Platform-neutral on purpose: the same teardown runs on Linux and macOS
      // and touches whichever user-service file the platform used. Loginctl
      // lingering is deliberately never disabled: it is a per-user setting the
      // provider does not own.
      steps: [
        {
          label: "Stop and disable the user service",
          optional: true,
          command: `if command -v systemctl >/dev/null 2>&1; then systemctl --user disable --now antigravity-proxy.service 2>/dev/null || true; fi; if command -v launchctl >/dev/null 2>&1; then launchctl bootout gui/$(id -u)/${ANTIGRAVITY_LAUNCHD_LABEL} 2>/dev/null || true; fi; if command -v antigravity-claude-proxy >/dev/null 2>&1; then antigravity-claude-proxy stop >/dev/null 2>&1 || true; fi`
        },
        {
          label: "Remove the user service file",
          optional: true,
          command: `rm -f {config}/systemd/user/antigravity-proxy.service {home}/Library/LaunchAgents/${ANTIGRAVITY_LAUNCHD_LABEL}.plist; if command -v systemctl >/dev/null 2>&1; then systemctl --user daemon-reload 2>/dev/null || true; fi`
        },
        // The package can sit in the install's fixed prefix, npm's own global
        // prefix, a version-manager prefix, or a system prefix; the sweep
        // uninstalls every one of them, fail-soft, and reports anything it
        // could not remove (a system prefix may need sudo).
        {
          label: "Uninstall the package from every npm prefix",
          optional: true,
          command: ANTIGRAVITY_PREFIX_SWEEP_COMMAND
        },
        // The launchd agent redirects stdout/stderr into ~/Library/Logs; the
        // step is a no-op on every other platform.
        {
          label: "Remove the macOS agent logs",
          optional: true,
          command: 'test "$(uname -s)" = Darwin || exit 0; rm -rf "{home}/Library/Logs/antigravity-proxy"*; exit 0'
        },
        // The package's full state directory: config.json, accounts.json
        // (every Google OAuth refresh token), usage-history.json, and the two
        // presets files. Required, not optional: a failure here means user
        // data survived the removal and must be reported.
        {
          label: "Remove the config directory (accounts.json OAuth tokens, usage history, presets)",
          command: "rm -rf {config}/antigravity-proxy"
        },
        // npm's content-addressed cache is shared with every other package and
        // self-pruning, so it is never wiped; an npx throwaway tree is
        // package-owned residue and is removed.
        {
          label: "Remove npm npx cache residue",
          optional: true,
          command: `rm -rf "{home}/.npm/_npx"/*/node_modules/${ANTIGRAVITY_PACKAGE} 2>/dev/null || true; exit 0`
        }
      ],
      warnings: [
        "Any other tool configured against the same proxy stops working when the service is removed",
        "If a dotfiles/config repository manages the service file (systemd unit or launchd plist), remove it there too or the next sync resurrects it",
        "The proxy state directory ~/.config/antigravity-proxy is deleted in full: accounts.json (every Google OAuth refresh token), usage-history.json, config.json, claude-presets.json, and server-presets.json are unrecoverable afterwards \u2014 back them up first if the accounts are shared elsewhere",
        "The Google Antigravity app's own database (~/.config/Antigravity) is only read by the proxy and is never touched by this removal",
        "loginctl lingering is left enabled \u2014 it is a per-user setting this teardown does not own",
        "npm's shared content-addressed cache (~/.npm/_cacache) still holds the downloaded tarball; it is shared with other packages, holds no account data, and is left in place",
        "DSH route, credential, pool state, discovered cache, and chain links are removed separately by this teardown"
      ]
    }
    // No fallbackModel: discovery is the only model source for this service.
    // An operator who has not added a Google account yet gets a route with an
    // empty model list, never a fabricated id the proxy never advertised.
  },
  {
    id: "commandcode",
    label: "Command Code",
    summary: "Command Code's CLI-shaped API at api.commandcode.ai, served by the DSH provider package and its native multi-key pool \u2014 no proxy.",
    protocol: "commandcode/alpha-generate",
    // The vendor is reached directly. The route profile carries its own key
    // pool: identities and priorities live in this route's settings namespace
    // (commandcode-provider) and the secrets live in the credentials store
    // (Settings → Models Keys card) or the environment. The provider package
    // injects the four CLI headers and rotates identities itself; the
    // standalone keypool proxy is not involved.
    auth: { kind: "unified", apiKeyEnv: "COMMANDCODE_KEY_1", keyless: false },
    delivery: "direct",
    docsUrl: "https://commandcode.ai",
    defaultPort: 443,
    // Served by `dsh-enpoi-commandcode-provider` (ctx.llm.registerAdapter), not
    // llm-pi-ai: the CLI-shaped protocol has no llm-pi-ai entry, so the route
    // profile must never be written into the llm-pi-ai schema.
    settingsNs: "commandcode-provider",
    // The route is pooled from its first request: an anonymous request cannot
    // pass the vendor gate, so the shipped starter identity gives the Keys
    // card its first key slot and a credential-less request fails with the
    // MISSING_CREDENTIAL action instead of falling back to keyless.
    pool: {
      strategy: "priority-sticky",
      identities: [{ id: "key-1", credentialRef: "COMMANDCODE_KEY_1", priority: 1 }]
    },
    // Browser badges belong only to account flows that cannot complete without
    // a browser (antigravity's Google OAuth); the vendor dashboard is an
    // ordinary quirk here, not an operator-blocking browser requirement.
    requiresBrowser: [],
    quirks: [
      "Local install dependencies: Node.js 22 (the setup step links and builds the provider package); Docker is never required, and no proxy or user service runs \u2014 the route talks to the vendor directly",
      'The vendor endpoint rejects generic HTTP clients ("Proxy use detected") \u2014 the provider package injects the four CLI headers itself; no proxy is required',
      "Keys are managed as pool identities on the Settings \u2192 Models Keys card: the route ships one starter identity (COMMANDCODE_KEY_1) and rotates identities in priority order",
      "The vendor account and quota dashboard live at commandcode.ai (browser)",
      "DSH speaks this protocol through the dsh-enpoi-commandcode-provider adapter; llm-pi-ai cannot declare it",
      "Migration: scripts/import-keypool-keys.mjs turns the old keypool pools.json commandcode keys into a settings pool block; it reads the old file but never prints key material",
      "An existing route still pointed at a loopback keypool keeps working until it is switched: set its baseURL to https://api.commandcode.ai, add the imported pool identities, then retire the proxy",
      "The provider package owns the request sanitizer (embedded-base64 scrub, 200k text cap, 413 strip-oldest retry) \u2014 clients must not duplicate it",
      'Quota is per key and real: the native pool rotates on exhaustion, and a QUOTA failure ("weekly usage limit" / "insufficient credits") appears only when every pooled identity is spent \u2014 a normal state, not a routing defect',
      "A route whose identities resolve no credential fails with MISSING_CREDENTIAL naming the Keys card; there is no anonymous fallback"
    ],
    reuse: {
      label: "Use the vendor endpoint now",
      baseURL: "https://api.commandcode.ai",
      note: "Writes the route at the vendor endpoint after confirming it answers; run the local setup first when the provider package is not linked yet.",
      health: COMMANDCODE_HEALTH
    },
    local: {
      label: "Link the provider package, then use the vendor endpoint",
      baseURL: "https://api.commandcode.ai",
      deps: ["Node.js 22"],
      diskHint: "~5 MB provider package; no local service, no GPU",
      runtime: "node",
      install: {
        // The setup is one shared, idempotent step; there is no service to
        // wrap and no proxy to deploy on any platform.
        default: { steps: [COMMANDCODE_INSTALL_STEP] },
        linux: { steps: [COMMANDCODE_INSTALL_STEP] },
        darwin: { steps: [COMMANDCODE_INSTALL_STEP] },
        win32: {
          label: "Not supported on Windows",
          unsupported: "The provider-package setup step runs through /bin/bash, which this profile does not provide on Windows. Link the package manually: from the profile root (normally ~/.dsh/profiles/web) run `node packages/enpoi-commandcode-provider/scripts/install.mjs .`, or run the harness on Linux/macOS.",
          steps: []
        }
      },
      health: COMMANDCODE_HEALTH
    },
    removal: {
      // No local service exists: the vendor endpoint needs no teardown and the
      // provider package is part of the shipped profile.
      steps: [],
      warnings: [
        "Removal drops only DSH state \u2014 the route, its COMMANDCODE_KEY_1 credential reference, its pool state, and its cache entry; no local service exists to stop",
        "Vendor keys stored under other pool identities (for example COMMANDCODE_KEY_2) are not deleted by removal \u2014 delete them on the Keys card",
        "Vendor account state and quota live at commandcode.ai and are never touched"
      ]
    },
    fallbackModel: "deepseek/deepseek-v4.1-flash"
  },
  {
    id: "meridian",
    label: "Claude Code (Meridian)",
    summary: "Local proxy that serves the operator's Claude subscription through the official Agent SDK as an Anthropic Messages-compatible endpoint.",
    protocol: "anthropic-messages",
    // Live probes against a shipped Meridian: budget-style thinking
    // (`{type: 'enabled', budget_tokens}`) is accepted and its budget ignored,
    // while adaptive thinking plus an effort level answers with reasoning
    // blocks. pi-ai emits the budget shape unless the route says otherwise, so
    // the compat switch is part of the provider's declaration, not an operator
    // preference.
    compat: { forceAdaptiveThinking: true },
    // A service instance on this device: detection and the health probe use
    // the loopback endpoint, and an operator's own host belongs in the
    // private server overlay.
    delivery: "service",
    // The proxy needs no client key: as shipped it is loopback-gated, and it
    // forwards no credential of its own (it drives the CLI login store).
    // llm-pi-ai serves keyless anthropic-messages routes, so the route is
    // written keyless and no stored or ambient key reaches the wire. An
    // operator who sets MERIDIAN_API_KEY retargets the route through the
    // server overlay with a unified key; the shipped table stays keyless.
    auth: { kind: "none", keyless: true },
    dashboardUrl: `http://127.0.0.1:${MERIDIAN_PORT}`,
    docsUrl: `https://www.npmjs.com/package/${MERIDIAN_PACKAGE}`,
    defaultPort: MERIDIAN_PORT,
    requiresBrowser: [
      "Signing the Claude Code CLI in to the subscription (`claude auth login --claudeai`) is a browser flow that writes the CLI login store; on a headless host the printed URL must be opened on a machine with a browser"
    ],
    quirks: [
      "Local install dependencies: Node.js >= 22 and npm (both packages are global npm installs behind a systemd or launchd user service); Docker is never required, and Windows has no supported local install \u2014 run the process manually or point the route at a proxy running elsewhere",
      "The @anthropic-ai/claude-code CLI must be installed and signed in to a Claude subscription (`claude auth login --claudeai`); ANTHROPIC_API_KEY must be unset during that login or the CLI can authenticate against API billing instead",
      "ExecStart must be `node <resolved>/dist/cli.js`, never the `meridian` bin: its `#!/usr/bin/env node` shebang does not resolve under systemd",
      "The unit PATH must contain the npm global bin (where `claude` lives), or the Agent SDK cannot spawn the CLI",
      "The model catalog ships inside each Meridian release: /v1/models answers from the build, not from a live CLI query, but an unknown model id still passes through to the SDK",
      'Thinking: budget-style `thinking: {type:"enabled", budget_tokens}` is accepted but its budget is ignored; adaptive thinking plus an effort level (`output_config.effort`) is the working shape, so this route is created with the llm-pi-ai compat switch `forceAdaptiveThinking`',
      "MERIDIAN_ENFORCE_MAX_TOKENS=1 is set here, so a harness that relies on max_tokens gets a hard budget",
      "x-session-affinity is optional and only matters for append-only clients; a request without it runs a fresh SDK session with the history packed into the system prompt",
      "Billing draws from the operator's own Claude subscription usage windows (like `claude -p`) \u2014 Meridian drives the official CLI/SDK and never reads or replays OAuth tokens"
    ],
    reuse: {
      label: "Use a detected instance",
      baseURL: `http://127.0.0.1:${MERIDIAN_PORT}`,
      note: "Zero install: uses a Meridian proxy already running on this device and its Claude subscription login.",
      health: MERIDIAN_HEALTH
    },
    local: {
      label: "Install locally (npm + user service)",
      baseURL: `http://127.0.0.1:${MERIDIAN_PORT}`,
      deps: ["Node.js >= 22", "A reachable systemd user session (systemctl --user) on the default path"],
      diskHint: "Two global npm packages and one Node process; no GPU, no Docker",
      dashboardUrl: `http://127.0.0.1:${MERIDIAN_PORT}`,
      runtime: "node",
      install: {
        // The npm packages are cross-platform; the user-service wrapper is
        // not. Linux (and systemd-like hosts) keeps the systemd unit, macOS
        // gets the launchd agent, and Windows has no POSIX user service.
        default: { steps: MERIDIAN_SYSTEMD_STEPS },
        linux: { label: "Install locally (npm + systemd user unit)", steps: MERIDIAN_SYSTEMD_STEPS },
        darwin: {
          label: "Install locally (npm + launchd agent)",
          deps: ["Node.js >= 22", "macOS 11+ (launchd)"],
          diskHint: "Two global npm packages and one Node process; no GPU, no Docker; logs in ~/Library/Logs",
          steps: MERIDIAN_LAUNCHD_STEPS
        },
        win32: {
          label: "Not supported on Windows",
          unsupported: `The Meridian local install needs a POSIX user service (systemd or launchd) to keep the proxy running; this profile has no supported Windows provisioning path. Install Node.js 22, run \`npm install -g ${MERIDIAN_CLAUDE_CLI_PACKAGE}\` and sign in with \`env -u ANTHROPIC_API_KEY claude auth login --claudeai\`, then \`npm install -g ${MERIDIAN_PACKAGE}\` and start \`node <npm root -g>/${MERIDIAN_PACKAGE}/dist/cli.js\` yourself with MERIDIAN_HOST=127.0.0.1, MERIDIAN_PORT=${MERIDIAN_PORT}, MERIDIAN_PASSTHROUGH=1 and MERIDIAN_ENFORCE_MAX_TOKENS=1 \u2014 or point the route at a Meridian proxy running elsewhere.`,
          steps: []
        }
      },
      health: MERIDIAN_HEALTH
    },
    removal: {
      // Platform-neutral like the antigravity teardown: it touches whichever
      // user-service file the platform wrote. The two npm global packages are
      // deliberately never uninstalled — the Claude Code CLI is a shared tool,
      // and Meridian may be the operator's only copy — so the last step states
      // that in its label instead of removing them.
      steps: [
        {
          label: "Stop and disable the user service",
          optional: true,
          command: `if command -v systemctl >/dev/null 2>&1; then systemctl --user disable --now meridian.service 2>/dev/null || true; fi; if command -v launchctl >/dev/null 2>&1; then launchctl bootout gui/$(id -u)/${MERIDIAN_LAUNCHD_LABEL} 2>/dev/null || true; fi`
        },
        {
          label: "Remove the user service file",
          optional: true,
          command: `rm -f {config}/systemd/user/meridian.service {home}/Library/LaunchAgents/${MERIDIAN_LAUNCHD_LABEL}.plist; if command -v systemctl >/dev/null 2>&1; then systemctl --user daemon-reload 2>/dev/null || true; fi`
        },
        {
          label: "Remove the macOS agent logs",
          optional: true,
          command: 'test "$(uname -s)" = Darwin || exit 0; rm -f "{home}/Library/Logs/meridian.log" "{home}/Library/Logs/meridian.err.log"; exit 0'
        },
        {
          label: `Leave the global npm packages installed (${MERIDIAN_PACKAGE} and ${MERIDIAN_CLAUDE_CLI_PACKAGE} are not uninstalled)`,
          optional: true,
          command: `echo "Meridian and the Claude Code CLI stay installed; remove them yourself with: npm uninstall -g ${MERIDIAN_PACKAGE} ${MERIDIAN_CLAUDE_CLI_PACKAGE}"`
        }
      ],
      warnings: [
        "Meridian and the Claude Code CLI stay installed as npm global packages \u2014 uninstall them yourself when no other tool uses them",
        "~/.config/meridian (profiles, settings, model pricing) and ~/.cache/meridian (sessions) are left in place; they hold no credentials, but delete them by hand if the install is not coming back",
        "The Claude CLI login store (~/.claude) belongs to the CLI and is never touched by this removal",
        "Any other tool pointed at the proxy stops working when the service is removed",
        "If a dotfiles/config repository manages the unit file (systemd unit or launchd plist), remove it there too or the next sync resurrects it",
        "Turns already served drew from the Claude subscription usage windows and are not refunded"
      ]
    }
    // No fallbackModel: /v1/models is the catalog shipped in the release, so
    // discovery is the only model source and nothing is fabricated.
  },
  {
    id: "cliproxyapi",
    label: "CLIProxyAPI",
    summary: "Optional multi-account subscription gateway: one OpenAI-compatible endpoint in front of the CLI accounts you configure in its dashboard.",
    protocol: "openai-completions",
    delivery: "service",
    // The endpoint's listing is authoritative: the gateway's channels decide
    // which models exist, and an empty successful listing is not backfilled
    // from the installed catalog.
    catalogAuthority: "endpoint",
    // The gateway's account-affinity route keys sessions by this header.
    sessionHeader: "x-session-id",
    // Anonymous routing is the shipped default; an operator may store the
    // optional gateway key under CLIPROXYAPI_API_KEY, but no key is required
    // for a local instance that accepts unauthenticated clients.
    auth: { kind: "unified", apiKeyEnv: "CLIPROXYAPI_API_KEY", keyless: true },
    dashboardUrl: `http://127.0.0.1:${CLIPROXYAPI_PORT}/management.html`,
    docsUrl: CLIPROXYAPI_DOCS_URL,
    defaultPort: CLIPROXYAPI_PORT,
    requiresBrowser: [
      "Adding upstream accounts happens in the local management dashboard; provider OAuth or device-code sign-in can require a browser or a phone confirmation and is never performed by the installer"
    ],
    quirks: [
      "Local install dependencies: Node.js >= 22 (the harness ships Node); Docker is never required. The profile helper downloads the verified CLIProxyAPI release and writes a systemd or launchd user service \u2014 no Go toolchain, npm compile, or curl step, and its Node built-in downloader needs no external tar",
      'The model catalog comes from the configured inference endpoint (/v1/models); this manifest hardcodes no model, declares catalogAuthority "endpoint", and never substitutes a fabricated fallback',
      "Model capabilities vary by upstream account/channel and by endpoint metadata; no native media capability is declared until the core native-media schema defines it",
      "The management key is separate from the optional client API key and stays in config.yaml with mode 0600; the installer prints neither key",
      "Upstream accounts are managed in the /management.html dashboard; the local installer never signs in or auto-authenticates an account, and opening the dashboard is a local handoff rather than an automatic login",
      "Remote management is a policy decision: the dashboard and management API are loopback by default, and exposing them beyond loopback requires an explicit tunnel and authentication you configure",
      "The route declaration sets the x-session-id request header for account affinity; affinity is not a cache-hit guarantee and accounts can still switch on quota or rate-limit responses",
      "The verified binary is about 75 MB; RAM use is not measured here. Removing the local install retains config.yaml, bootstrap.json, and the auths directory under $DSH_HOME/providers/cliproxyapi",
      "Windows has no supported local install; detected-instance reuse, a custom route, or an instance running on another machine still works"
    ],
    reuse: {
      label: "Use a detected instance",
      baseURL: `http://127.0.0.1:${CLIPROXYAPI_PORT}/v1`,
      note: "Zero install: uses a CLIProxyAPI instance already running on this device. The client API key is optional and the dashboard is not signed in automatically.",
      health: CLIPROXYAPI_HEALTH
    },
    local: {
      label: "Install locally (verified release + user service)",
      baseURL: `http://127.0.0.1:${CLIPROXYAPI_PORT}/v1`,
      deps: ["Node.js >= 22", "A reachable systemd user session (systemctl --user) on Linux"],
      diskHint: "~75 MB binary; RAM use not measured",
      dashboardUrl: `http://127.0.0.1:${CLIPROXYAPI_PORT}/management.html`,
      runtime: "node",
      install: {
        default: {
          steps: [CLIPROXYAPI_INSTALL_STEP],
          requiresFiles: [CLIPROXYAPI_HELPER_FILE]
        },
        linux: {
          label: "Install locally (verified release + systemd user unit)",
          requires: ["systemd-user"],
          steps: [CLIPROXYAPI_INSTALL_STEP],
          requiresFiles: [CLIPROXYAPI_HELPER_FILE]
        },
        darwin: {
          label: "Install locally (verified release + launchd agent)",
          deps: ["Node.js >= 22", "macOS 11+ (launchd)"],
          diskHint: "~75 MB binary; RAM use not measured",
          steps: [CLIPROXYAPI_INSTALL_STEP],
          requiresFiles: [CLIPROXYAPI_HELPER_FILE]
        },
        win32: {
          label: "Not supported on Windows",
          unsupported: 'CLIProxyAPI has no supported Windows local install: its installer helper manages a verified Linux/macOS release behind a POSIX user service. Run CLIProxyAPI yourself, or add an instance running on another machine with "Use a detected instance" or as a custom route.',
          steps: []
        }
      },
      health: CLIPROXYAPI_HEALTH
    },
    removal: {
      steps: [CLIPROXYAPI_REMOVE_STEP],
      warnings: [
        "Removal stops the receipt-owned user service and removes the verified binary plus the receipt-owned unit; config.yaml (management key, mode 0600), bootstrap.json, and the auths directory (upstream account credentials) stay under $DSH_HOME/providers/cliproxyapi and must be deleted by hand to remove them",
        "Any other harness or client pointed at the same CLIProxyAPI instance stops working when the service is removed",
        "Upstream account state and quota live in CLIProxyAPI and are never touched beyond the local service and binary",
        "A modified binary or unit makes the installer refuse removal; restore the receipt-owned file or remove it manually after confirming its origin"
      ]
    }
    // No fallbackModel: the endpoint's /v1/models listing is the only model
    // source, so an empty listing writes no fabricated id.
  }
];
function manifestById(id) {
  return HEAVY_MANIFESTS.find((manifest) => manifest.id === id);
}
function manifestProblems(manifests = HEAVY_MANIFESTS) {
  const problems = [];
  const seen = /* @__PURE__ */ new Set();
  for (const manifest of manifests) {
    const where = `manifest "${manifest.id}"`;
    if (manifest.id === "") problems.push(`${where}: id is empty`);
    if (seen.has(manifest.id)) problems.push(`${where}: duplicate id`);
    seen.add(manifest.id);
    for (const [field, value] of [["label", manifest.label], ["summary", manifest.summary], ["protocol", manifest.protocol]]) {
      if (typeof value !== "string" || value.trim() === "") problems.push(`${where}: ${field} is empty`);
    }
    if (!Number.isInteger(manifest.defaultPort) || manifest.defaultPort < 1 || manifest.defaultPort > 65535) {
      problems.push(`${where}: defaultPort must be a TCP port`);
    }
    if (manifest.reuse.baseURL === "" && manifest.unsupported === void 0) problems.push(`${where}: reuse.baseURL is empty`);
    if (manifest.reuse.health.url === "") problems.push(`${where}: reuse.health.url is empty`);
    const variants = [manifest.local.install.default, manifest.local.install.linux, manifest.local.install.darwin, manifest.local.install.win32];
    if (manifest.unsupported === void 0) {
      if (manifest.local.install.default.steps.length === 0) problems.push(`${where}: local.install.default is empty`);
      if (manifest.local.baseURL === "") problems.push(`${where}: local.baseURL is empty`);
      if (manifest.local.health.url === "") problems.push(`${where}: local.health.url is empty`);
    }
    for (const [index, variant] of variants.entries()) {
      if (variant === void 0) continue;
      const variantWhere = `${where}: platform install variant ${String(index)}`;
      if (variant.unsupported !== void 0 && variant.unsupported.trim() === "") {
        problems.push(`${variantWhere} declares an empty unsupported reason`);
      }
      if (variant.steps.length === 0 && variant.unsupported === void 0 && manifest.unsupported === void 0) {
        problems.push(`${variantWhere} has no steps`);
      }
      for (const requirement of variant.requiresFiles ?? []) {
        if (requirement.paths.length === 0 || requirement.hint.trim() === "") {
          problems.push(`${variantWhere} file requirement needs at least one path and a hint`);
        }
      }
      if (variant.unsupported !== void 0) continue;
      const runtime = variant.runtime ?? manifest.local.runtime;
      const declared = runtime === void 0 ? void 0 : RUNTIME_TOOL_RE[runtime];
      if (declared === void 0 || variant.steps.length === 0) continue;
      const commands = variant.steps.map((step) => step.command).join("\n");
      if (declared.test(commands)) continue;
      const conflicting = Object.keys(RUNTIME_TOOL_RE).filter((other) => other !== runtime && RUNTIME_TOOL_RE[other]?.test(commands) === true);
      if (conflicting.length > 0) {
        problems.push(`${variantWhere} declares runtime "${String(runtime)}" but its steps invoke ${conflicting.join("/")} tooling instead`);
      }
    }
    if (manifest.settingsNs !== void 0 && !/^[a-z0-9][a-z0-9-]*$/.test(manifest.settingsNs)) {
      problems.push(`${where}: settingsNs must be a lowercase plugin entry id`);
    }
    if (manifest.unsupported === void 0 && !LLM_PI_AI_PROTOCOLS.includes(manifest.protocol) && manifest.settingsNs === void 0) {
      problems.push(`${where}: protocol "${manifest.protocol}" is not served by llm-pi-ai and needs an explicit settingsNs`);
    }
    if (manifest.sessionHeader !== void 0 && (typeof manifest.sessionHeader !== "string" || manifest.sessionHeader.trim() === "")) {
      problems.push(`${where}: sessionHeader must be a non-empty header name`);
    }
    if (manifest.catalogAuthority !== void 0 && manifest.catalogAuthority !== "endpoint") {
      problems.push(`${where}: catalogAuthority must be "endpoint" when declared`);
    }
    if (manifest.releaseSource !== void 0 && parseReleaseSource(manifest.releaseSource) === void 0) {
      problems.push(`${where}: releaseSource must be an https URL or an "owner/repo" slug`);
    }
    const offered = offeredCompatFields(manifest.protocol);
    for (const [field, value] of Object.entries(manifest.compat ?? {})) {
      if (!offered.includes(field)) {
        problems.push(`${where}: compat "${field}" is not offered by protocol "${manifest.protocol}"` + (offered.length === 0 ? " (that protocol takes no compat)" : `; offered: ${offered.join(", ")}`));
      }
      if (typeof value !== "boolean") problems.push(`${where}: compat "${field}" must be true or false`);
    }
    if (manifest.delivery === "direct" && manifest.unsupported === void 0 && manifest.pool === void 0 && manifest.auth.kind === "none") {
      problems.push(`${where}: a direct route must declare a key pool or a non-keyless auth kind`);
    }
    if (manifest.pool !== void 0) {
      if (manifest.settingsNs === void 0) {
        problems.push(`${where}: a key pool needs its own settingsNs; llm-pi-ai routes must not declare one`);
      }
      if (manifest.pool.identities.length === 0) problems.push(`${where}: the key pool declares no identities`);
      const identityIds = /* @__PURE__ */ new Set();
      for (const identity of manifest.pool.identities) {
        if (identity.id === "") problems.push(`${where}: a key-pool identity has an empty id`);
        if (identityIds.has(identity.id)) problems.push(`${where}: key-pool identity id "${identity.id}" is duplicated`);
        identityIds.add(identity.id);
        if (!/^[A-Z_][A-Z0-9_]*$/.test(identity.credentialRef)) {
          problems.push(`${where}: key-pool identity "${identity.id}" credentialRef must be an uppercase credential reference`);
        }
        if (identity.priority !== void 0 && (!Number.isSafeInteger(identity.priority) || identity.priority < 0)) {
          problems.push(`${where}: key-pool identity "${identity.id}" priority must be a non-negative integer`);
        }
        if (identity.enabled !== void 0 && typeof identity.enabled !== "boolean") {
          problems.push(`${where}: key-pool identity "${identity.id}" enabled must be a boolean`);
        }
      }
    }
    if (manifest.removal.warnings.length === 0) problems.push(`${where}: removal.warnings is empty`);
    if (manifest.auth.kind !== "none" && (manifest.auth.apiKeyEnv === void 0 || !/^[A-Z_][A-Z0-9_]*$/.test(manifest.auth.apiKeyEnv))) {
      problems.push(`${where}: apiKeyEnv must be an uppercase credential reference`);
    }
    for (const step of [...variants.flatMap((variant) => variant?.steps ?? []), ...manifest.removal.steps]) {
      if (step.command.trim() === "") problems.push(`${where}: a step command is empty (${step.label})`);
    }
  }
  return problems;
}

// src/planner.ts
import { existsSync, mkdirSync as mkdirSync4, readFileSync as readFileSync4, renameSync as renameSync3, rmSync as rmSync3, writeFileSync as writeFileSync4 } from "node:fs";
import { dirname as dirname2, join as join4 } from "node:path";
import { listingText, readModelListing } from "@deepseek-ai/dsh-llm-pi-ai";

// src/state.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { mkdirSync as mkdirSync3, readFileSync as readFileSync3, readdirSync as readdirSync3, renameSync as renameSync2, rmSync as rmSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname, join as join3 } from "node:path";
var HEAVY_LIFECYCLE_DIRECTORY = "heavy-providers";
var HEAVY_LIFECYCLE_FILE = "heavy-providers.json";
var HEAVY_LIFECYCLE_VERSION = 1;
var MAX_RECEIPT_CHARS = 512;
function heavyLifecyclePath(dshHome) {
  return join3(dshHome, HEAVY_LIFECYCLE_FILE);
}
function heavyLifecycleDirectory(dshHome) {
  return join3(dshHome, HEAVY_LIFECYCLE_DIRECTORY);
}
function providerLifecyclePath(dshHome, id) {
  if (id === "") throw new Error("heavy-provider lifecycle id is empty");
  return join3(heavyLifecycleDirectory(dshHome), `${encodeURIComponent(id)}.json`);
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function errorCode2(error) {
  return error?.code;
}
function readEntry(raw) {
  if (!isRecord(raw)) return void 0;
  const mode = raw.mode;
  if (mode !== "reuse" && mode !== "local") return void 0;
  if (typeof raw.installedByHarness !== "boolean") return void 0;
  const receipt = raw.receipt;
  if (receipt !== void 0 && (typeof receipt !== "string" || receipt === "" || receipt.length > MAX_RECEIPT_CHARS)) {
    return void 0;
  }
  if (mode === "local" && (raw.installedByHarness !== true || receipt === void 0)) return void 0;
  if (mode === "reuse" && raw.installedByHarness !== false) return void 0;
  if (typeof raw.updatedAt !== "number" || !Number.isFinite(raw.updatedAt) || raw.updatedAt < 0) return void 0;
  const setupKind = raw.setupKind;
  const validSetupKind = setupKind === "harness-install" || setupKind === "detected-instance" || setupKind === "custom-instance" ? setupKind : void 0;
  const endpoint = typeof raw.endpoint === "string" && raw.endpoint.length > 0 && raw.endpoint.length <= 2048 ? raw.endpoint : void 0;
  return {
    mode,
    installedByHarness: raw.installedByHarness,
    ...receipt === void 0 ? {} : { receipt },
    ...validSetupKind === void 0 ? {} : { setupKind: validSetupKind },
    ...endpoint === void 0 ? {} : { endpoint },
    updatedAt: raw.updatedAt
  };
}
function readLegacyAggregate(dshHome) {
  try {
    const raw = JSON.parse(readFileSync3(heavyLifecyclePath(dshHome), "utf8"));
    if (!isRecord(raw) || raw.version !== HEAVY_LIFECYCLE_VERSION || !isRecord(raw.providers)) {
      return { version: HEAVY_LIFECYCLE_VERSION, providers: {} };
    }
    const providers = {};
    for (const [id, value] of Object.entries(raw.providers)) {
      const entry = readEntry(value);
      if (id !== "" && entry !== void 0) providers[id] = entry;
    }
    return { version: HEAVY_LIFECYCLE_VERSION, providers };
  } catch {
    return { version: HEAVY_LIFECYCLE_VERSION, providers: {} };
  }
}
function readProviderRecord(dshHome, id) {
  let raw;
  try {
    raw = JSON.parse(readFileSync3(providerLifecyclePath(dshHome, id), "utf8"));
  } catch (error) {
    return errorCode2(error) === "ENOENT" ? { kind: "missing" } : { kind: "invalid" };
  }
  if (!isRecord(raw) || raw.version !== HEAVY_LIFECYCLE_VERSION || raw.id !== id) return { kind: "invalid" };
  if (raw.cleared === true) return { kind: "cleared" };
  const entry = readEntry(raw);
  return entry === void 0 ? { kind: "invalid" } : { kind: "entry", entry };
}
function lifecycleOf(dshHome, id) {
  const local = readProviderRecord(dshHome, id);
  if (local.kind === "entry") return local.entry;
  if (local.kind !== "missing") return void 0;
  return readLegacyAggregate(dshHome).providers[id];
}
function ownsLocalInstall(entry) {
  return entry !== void 0 && entry.mode === "local" && entry.installedByHarness && entry.receipt !== void 0 && entry.receipt.length > 0;
}
function persist(path, record) {
  mkdirSync3(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${String(process.pid)}-${randomUUID2()}`;
  try {
    writeFileSync3(temporary, JSON.stringify(record), { encoding: "utf8", mode: 384 });
    renameSync2(temporary, path);
  } catch (error) {
    rmSync2(temporary, { force: true });
    throw error;
  }
}
function writeProviderLifecycle(dshHome, id, entry, now = Date.now) {
  const path = providerLifecyclePath(dshHome, id);
  persist(
    path,
    entry === null ? { version: HEAVY_LIFECYCLE_VERSION, id, cleared: true } : { version: HEAVY_LIFECYCLE_VERSION, id, ...entry, updatedAt: now() }
  );
}
function recordReuseLifecycle(dshHome, id, options) {
  writeProviderLifecycle(dshHome, id, {
    mode: "reuse",
    installedByHarness: false,
    ...options?.setupKind ? { setupKind: options.setupKind } : {},
    ...options?.endpoint ? { endpoint: options.endpoint } : {}
  });
}
function registerInstallOwnership(dshHome, id, receipt, options) {
  const trimmed = receipt.trim();
  if (trimmed === "") throw new Error("heavy-provider ownership receipt is empty");
  if (trimmed.length > MAX_RECEIPT_CHARS) throw new Error("heavy-provider ownership receipt is too long");
  writeProviderLifecycle(dshHome, id, {
    mode: "local",
    installedByHarness: true,
    receipt: trimmed,
    setupKind: options?.setupKind ?? "harness-install",
    ...options?.endpoint ? { endpoint: options.endpoint } : {}
  });
}
function clearProviderLifecycle(dshHome, id) {
  writeProviderLifecycle(dshHome, id, null);
}

// src/planner.ts
var LLM_NS = "llm-pi-ai";
var ORCHESTRATION_NS = "enpoi-orchestration";
var UNSAFE_PLACEHOLDER_CHAR = /[\u0000\n\r`$"';|&<>()*?\[\]{}!#~]/;
function substitute(value, home, dshHome, profileDir) {
  const expand = (source, token, replacement) => {
    if (!source.includes(token)) return source;
    if (UNSAFE_PLACEHOLDER_CHAR.test(replacement)) {
      throw new Error(
        `Cannot expand ${token}: the host path contains a shell metacharacter, so interpolating it into a command would change what the shell executes. Commands that need a host path must read it from the runner environment instead.`
      );
    }
    return source.replaceAll(token, replacement);
  };
  let expanded = expand(value, "{home}", home);
  expanded = expand(expanded, "{config}", join4(home, ".config"));
  expanded = expand(expanded, "{dshHome}", dshHome ?? join4(home, ".dsh"));
  return profileDir === void 0 ? expanded : expand(expanded, "{profileDir}", profileDir);
}
function modeBaseURL(manifest, mode) {
  return mode === "reuse" ? manifest.reuse.baseURL : manifest.local.baseURL;
}
function urlPort(url) {
  try {
    const parsed = new URL(url);
    if (parsed.port !== "") return Number(parsed.port);
    return parsed.protocol === "https:" ? 443 : parsed.protocol === "http:" ? 80 : void 0;
  } catch {
    return void 0;
  }
}
function urlPath(url) {
  try {
    const path = new URL(url).pathname;
    return path === "/" ? "" : path;
  } catch {
    return "";
  }
}
function instanceHealth(manifest, port) {
  return { ...manifest.local.health, url: `http://127.0.0.1:${port}${urlPath(manifest.local.health.url)}` };
}
function instanceBaseURL(manifest, port) {
  return `http://127.0.0.1:${port}${urlPath(manifest.reuse.baseURL)}`;
}
function healthForBase(manifest, baseURL) {
  try {
    const base = new URL(baseURL);
    const declared = new URL(manifest.reuse.health.url);
    return { ...manifest.reuse.health, url: `${base.protocol}//${base.host}${declared.pathname}` };
  } catch {
    return manifest.reuse.health;
  }
}
function instanceBaseURLFromInput(value) {
  const trimmed = value.trim();
  if (trimmed === "") return void 0;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return void 0;
    if (parsed.username !== "" || parsed.password !== "") return void 0;
    if (parsed.search !== "" || parsed.hash !== "") return void 0;
    if (parsed.port !== "" && Number(parsed.port) < 1) return void 0;
    return parsed.origin;
  } catch {
    return void 0;
  }
}
function instanceCandidates(manifest, configuredBaseURL) {
  if (manifest.delivery === "direct") return [];
  const candidates = [];
  const add = (baseURL, url) => {
    if (candidates.some((candidate) => candidate.url === url)) return;
    const port = urlPort(baseURL);
    candidates.push({ url, baseURL, ...port === void 0 ? {} : { port } });
  };
  if (configuredBaseURL !== void 0 && configuredBaseURL !== "") {
    add(configuredBaseURL, healthForBase(manifest, configuredBaseURL).url);
  }
  add(manifest.reuse.baseURL, manifest.reuse.health.url);
  add(instanceBaseURL(manifest, manifest.defaultPort), instanceHealth(manifest, manifest.defaultPort).url);
  return candidates;
}
function reachable(health) {
  return health.ok || health.status === 401 || health.status === 403;
}
async function detectInstance(deps, manifest, configuredBaseURL) {
  if (manifest.delivery === "direct") {
    return {
      ok: false,
      baseURL: manifest.reuse.baseURL,
      url: manifest.reuse.health.url,
      health: { ok: false, error: "direct vendor endpoint \u2014 no local instance to detect", checkedAt: Date.now() }
    };
  }
  let firstFailure;
  for (const candidate of instanceCandidates(manifest, configuredBaseURL)) {
    const health = await probeHealth({ ...manifest.reuse.health, url: candidate.url }, deps.fetchImpl);
    const detection = {
      ok: reachable(health),
      baseURL: candidate.baseURL,
      ...candidate.port === void 0 ? {} : { port: candidate.port },
      url: candidate.url,
      health
    };
    if (reachable(health)) return detection;
    firstFailure ??= detection;
  }
  return firstFailure ?? {
    ok: false,
    baseURL: manifest.reuse.baseURL,
    url: manifest.reuse.health.url,
    health: { ok: false, error: "no probe candidates", checkedAt: Date.now() }
  };
}
async function detectRuntimes(runStep2) {
  try {
    const outcome = await runStep2({
      label: "Detect local runtimes",
      command: "command -v docker >/dev/null 2>&1 && echo available:docker; command -v podman >/dev/null 2>&1 && echo available:podman; command -v node >/dev/null 2>&1 && echo available:node; command -v node >/dev/null 2>&1 && node -v 2>/dev/null | cut -d. -f1 | tr -d v | sed 's/^/node-major:/'; systemctl --user show-environment >/dev/null 2>&1 && echo available:systemd-user; exit 0"
    });
    const nodeMajor = /(^|\n)node-major:(\d+)(\n|$)/.exec(outcome.output)?.[2];
    return {
      docker: /(^|\n)available:docker(\n|$)/.test(outcome.output),
      podman: /(^|\n)available:podman(\n|$)/.test(outcome.output),
      node: /(^|\n)available:node(\n|$)/.test(outcome.output),
      ...nodeMajor === void 0 ? {} : { nodeMajor: Number(nodeMajor) },
      systemdUser: /(^|\n)available:systemd-user(\n|$)/.test(outcome.output)
    };
  } catch {
    return { docker: false, podman: false, node: false, systemdUser: false };
  }
}
function missingFileRequirement(requirements, context) {
  if (context === void 0) return void 0;
  for (const requirement of requirements ?? []) {
    const withHelper = requirement.paths.map((path) => {
      if (!path.includes("{helper}")) return path;
      return context.helperPath === void 0 ? void 0 : path.replaceAll("{helper}", context.helperPath);
    });
    if (withHelper.some((path) => path === void 0 ? true : existsSync(substitute(path, context.home, context.dshHome, context.profileDir)))) continue;
    return requirement.hint;
  }
  return void 0;
}
function declaredRuntime(manifest, platform) {
  const variant = platform === "linux" || platform === "darwin" || platform === "win32" ? manifest.local.install[platform] : void 0;
  return variant?.runtime ?? manifest.local.runtime ?? "node";
}
function declaredNodeMajor(deps) {
  for (const dep of deps) {
    const match = /^Node\.js\s*(?:>=\s*)?(\d+)/.exec(dep.trim());
    if (match?.[1] !== void 0) return Number(match[1]);
  }
  return void 0;
}
function chooseLocalPath(manifest, platform, runtime, detectedPort, context) {
  const resolved = resolveHeavyInstall(manifest.local, platform);
  if (detectedPort !== void 0) {
    return { path: "detected", label: "Use the detected instance", deps: [], diskHint: "", steps: [], requires: [], missing: [] };
  }
  const base = { deps: resolved.deps, diskHint: resolved.diskHint, steps: resolved.steps };
  const blocked = platformUnsupported(manifest, platform);
  if (blocked !== void 0) {
    return { path: "unsupported", label: resolved.label, ...base, requires: [], missing: [blocked] };
  }
  const missingFile = missingFileRequirement(platformInstallVariant(manifest.local, platform).requiresFiles, context);
  if (missingFile !== void 0) {
    return { path: "unsupported", label: resolved.label, ...base, requires: [], missing: [missingFile] };
  }
  switch (declaredRuntime(manifest, platform)) {
    case "docker":
      if (runtime.docker) return { path: "docker", label: resolved.label, ...base, requires: ["docker"], missing: [] };
      if (runtime.podman) return { path: "podman", label: resolved.label, ...base, requires: ["podman"], missing: [] };
      return { path: "unsupported", label: resolved.label, ...base, requires: ["docker"], missing: ["Docker Engine + Compose (or Podman)"] };
    case "podman":
      return runtime.podman ? { path: "podman", label: resolved.label, ...base, requires: ["podman"], missing: [] } : { path: "unsupported", label: resolved.label, ...base, requires: ["podman"], missing: ["Podman"] };
    case "vendor-app":
      return { path: "vendor-app", label: resolved.label, ...base, requires: [], missing: [] };
    case "node": {
      if (!runtime.node) {
        return { path: "unsupported", label: resolved.label, ...base, requires: [], missing: [resolved.deps[0] ?? "Node.js"] };
      }
      const requiredNodeMajor = declaredNodeMajor(resolved.deps);
      if (requiredNodeMajor !== void 0 && runtime.nodeMajor !== void 0 && runtime.nodeMajor < requiredNodeMajor) {
        return { path: "unsupported", label: resolved.label, ...base, requires: [], missing: [`Node.js >= ${String(requiredNodeMajor)}`] };
      }
      const needsSystemdUser = platformInstallVariant(manifest.local, platform).requires?.includes("systemd-user") === true || resolved.steps.some((step) => step.command.includes("systemctl --user"));
      if (needsSystemdUser && !runtime.systemdUser) {
        return {
          path: "unsupported",
          label: resolved.label,
          ...base,
          requires: ["systemd-user"],
          missing: ["A reachable systemd user session (`systemctl --user`)"]
        };
      }
      return { path: "node", label: resolved.label, ...base, requires: [], missing: [] };
    }
  }
}
function isOverlayRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function overlayString(record, key) {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : void 0;
}
function overlayNullableString(record, key) {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string") return void 0;
  return value === "" ? null : value;
}
function overlaySteps(value) {
  if (!Array.isArray(value) || value.length === 0) return void 0;
  const steps = [];
  for (const raw of value) {
    if (!isOverlayRecord(raw)) return void 0;
    const label = overlayString(raw, "label");
    const command = overlayString(raw, "command");
    if (label === void 0 || command === void 0) return void 0;
    const cwd = overlayString(raw, "cwd");
    const weight = typeof raw.weight === "number" && Number.isFinite(raw.weight) && raw.weight > 0 ? raw.weight : void 0;
    steps.push({
      label,
      command,
      ...cwd === void 0 ? {} : { cwd },
      ...raw.optional === true ? { optional: true } : {},
      ...weight === void 0 ? {} : { weight }
    });
  }
  return steps;
}
function overlayPool(value) {
  if (value === null) return null;
  if (!isOverlayRecord(value)) return void 0;
  const strategy = value.strategy;
  if (strategy !== void 0 && strategy !== "priority-sticky" && strategy !== "balanced") return void 0;
  if (!Array.isArray(value.identities) || value.identities.length === 0) return void 0;
  const identities = [];
  const seen = /* @__PURE__ */ new Set();
  for (const raw of value.identities) {
    if (!isOverlayRecord(raw)) return void 0;
    const id = overlayString(raw, "id");
    const credentialRef = overlayString(raw, "credentialRef");
    if (id === void 0 || credentialRef === void 0 || !/^[A-Z_][A-Z0-9_]*$/.test(credentialRef) || seen.has(id)) {
      return void 0;
    }
    seen.add(id);
    const priority = raw.priority;
    if (priority !== void 0 && (typeof priority !== "number" || !Number.isSafeInteger(priority) || priority < 0)) {
      return void 0;
    }
    if (raw.enabled !== void 0 && typeof raw.enabled !== "boolean") return void 0;
    identities.push({
      id,
      credentialRef,
      ...typeof priority === "number" ? { priority } : {},
      ...typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}
    });
  }
  return { ...strategy === void 0 ? {} : { strategy }, identities };
}
function sanitizeOverlayEntry(raw) {
  if (!isOverlayRecord(raw)) return void 0;
  const entry = {};
  if (raw.disabled === true) entry.disabled = true;
  const label = overlayString(raw, "label");
  if (label !== void 0) entry.label = label;
  const summary = overlayString(raw, "summary");
  if (summary !== void 0) entry.summary = summary;
  const dashboardUrl = overlayNullableString(raw, "dashboardUrl");
  if (dashboardUrl !== void 0) entry.dashboardUrl = dashboardUrl;
  const docsUrl = overlayNullableString(raw, "docsUrl");
  if (docsUrl !== void 0) entry.docsUrl = docsUrl;
  const reuseBaseURL = overlayString(raw, "reuseBaseURL");
  if (reuseBaseURL !== void 0) entry.reuseBaseURL = reuseBaseURL;
  const reuseHealthURL = overlayString(raw, "reuseHealthURL");
  if (reuseHealthURL !== void 0) entry.reuseHealthURL = reuseHealthURL;
  const installSteps = overlaySteps(raw.installSteps);
  if (installSteps !== void 0) entry.installSteps = installSteps;
  const fallbackModel = overlayNullableString(raw, "fallbackModel");
  if (fallbackModel !== void 0) entry.fallbackModel = fallbackModel;
  const pool = overlayPool(raw.pool);
  if (pool !== void 0) entry.pool = pool;
  const releaseSource = overlayString(raw, "releaseSource");
  if (releaseSource !== void 0 && parseReleaseSource(releaseSource) !== void 0) entry.releaseSource = releaseSource;
  return Object.keys(entry).length === 0 ? void 0 : entry;
}
function readServerOverlay(dshHome) {
  try {
    const document = JSON.parse(readFileSync4(join4(dshHome, "heavy-server-overlay.json"), "utf8"));
    if (!isOverlayRecord(document) || !isOverlayRecord(document.providers)) return {};
    const overlay = {};
    for (const [id, raw] of Object.entries(document.providers)) {
      const entry = sanitizeOverlayEntry(raw);
      if (id !== "" && entry !== void 0) overlay[id] = entry;
    }
    return overlay;
  } catch {
    return {};
  }
}
function replaceInstallSteps(local, steps) {
  const install = { ...local.install };
  for (const platform of ["default", "linux", "darwin", "win32"]) {
    const variant = install[platform];
    if (variant === void 0 || variant.unsupported !== void 0) continue;
    install[platform] = { ...variant, steps };
  }
  return { ...local, install };
}
function overlayManifest(manifest, entry) {
  if (entry === void 0) return manifest;
  const next = {
    ...manifest,
    ...entry.label === void 0 ? {} : { label: entry.label },
    ...entry.summary === void 0 ? {} : { summary: entry.summary },
    reuse: {
      ...manifest.reuse,
      ...entry.reuseBaseURL === void 0 ? {} : { baseURL: entry.reuseBaseURL },
      ...entry.reuseHealthURL === void 0 ? {} : { health: { ...manifest.reuse.health, url: entry.reuseHealthURL } }
    },
    local: entry.installSteps === void 0 ? manifest.local : replaceInstallSteps(manifest.local, entry.installSteps)
  };
  if (entry.dashboardUrl === null) delete next.dashboardUrl;
  else if (entry.dashboardUrl !== void 0) next.dashboardUrl = entry.dashboardUrl;
  if (entry.docsUrl === null) delete next.docsUrl;
  else if (entry.docsUrl !== void 0) next.docsUrl = entry.docsUrl;
  if (entry.fallbackModel === null) delete next.fallbackModel;
  else if (entry.fallbackModel !== void 0) next.fallbackModel = entry.fallbackModel;
  if (entry.pool === null) delete next.pool;
  else if (entry.pool !== void 0) next.pool = entry.pool;
  if (entry.releaseSource !== void 0) next.releaseSource = entry.releaseSource;
  return next;
}
function effectiveHeavyManifests(manifests, overlay) {
  const effective = [];
  for (const manifest of manifests) {
    const entry = overlay[manifest.id];
    if (entry?.disabled === true) continue;
    effective.push(overlayManifest(manifest, entry));
  }
  return effective;
}
var HEAVY_OVERLAY_GLOBAL = "__DSH_HEAVY_OVERLAY__";
function overlayInjectionRow(dshHome) {
  const providers = readServerOverlay(dshHome);
  if (Object.keys(providers).length === 0) return void 0;
  return { kind: "global", name: HEAVY_OVERLAY_GLOBAL, value: { providers } };
}
function catalogAuthorityOf(manifest) {
  return manifest.catalogAuthority;
}
function routeProfile(manifest, mode, models, overrides = {}) {
  const authority = overrides.catalogAuthority ?? catalogAuthorityOf(manifest);
  const anonymous = manifest.auth.kind === "none" ? true : overrides.keyless ?? manifest.auth.keyless;
  const carriesKey = !anonymous && manifest.auth.apiKeyEnv !== void 0;
  const explicitKeyless = manifest.auth.kind === "unified" && !anonymous && manifest.auth.keyless;
  const piAiRoute = routeSettingsNs(manifest) === LLM_NS;
  const list = models.length > 0 ? models.map((model) => ({
    id: model.id,
    ...model.name === void 0 ? {} : { name: model.name },
    ...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
    ...model.maxInputTokens === void 0 ? {} : { maxInputTokens: model.maxInputTokens },
    ...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
    ...model.input === void 0 || model.input.length === 0 ? {} : { input: [...model.input] },
    ...!piAiRoute || model.tools === void 0 ? {} : { tools: model.tools },
    ...!piAiRoute || model.reasoning === void 0 ? {} : { reasoning: model.reasoning },
    // An empty ladder states nothing and the route schema refuses it as a
    // declared-but-empty capability, so it is omitted like an absent one.
    // An explicit false is a declared answer and stays.
    ...model.reasoningEfforts === void 0 ? {} : model.reasoningEfforts === false ? { reasoningEfforts: false } : Object.keys(model.reasoningEfforts).length === 0 ? {} : { reasoningEfforts: { ...model.reasoningEfforts } }
  })) : authority === "endpoint" || manifest.fallbackModel === void 0 || overrides.catalogState !== "empty" ? [] : [{ id: manifest.fallbackModel, name: `${manifest.fallbackModel} (fallback)` }];
  const suffix = manifest.delivery === "direct" ? " (direct)" : mode === "local" ? " (local)" : " (detected)";
  return {
    displayName: `${manifest.label}${suffix}`,
    api: manifest.protocol,
    baseURL: overrides.baseURL ?? modeBaseURL(manifest, mode),
    ...carriesKey ? { apiKeyEnv: manifest.auth.apiKeyEnv } : {},
    ...anonymous || explicitKeyless ? { keyless: anonymous } : {},
    ...manifest.compat === void 0 ? {} : { compat: { ...manifest.compat } },
    ...manifest.sessionHeader === void 0 ? {} : { sessionHeader: manifest.sessionHeader },
    ...authority === "endpoint" ? { catalogAuthority: "endpoint" } : {},
    ...manifest.pool === void 0 ? {} : {
      pool: {
        ...manifest.pool.strategy === void 0 ? {} : { strategy: manifest.pool.strategy },
        identities: manifest.pool.identities.map((identity) => ({ ...identity }))
      }
    },
    models: list
  };
}
async function probeHealth(probe, fetchImpl = globalThis.fetch, now = Date.now) {
  const checkedAt = now();
  try {
    const response = await fetchImpl(probe.url, {
      ...probe.headers === void 0 ? {} : { headers: { ...probe.headers } },
      signal: AbortSignal.timeout(probe.timeoutMs ?? 5e3)
    });
    const accepted = probe.expectStatus ?? void 0;
    const statusOk = accepted === void 0 ? response.status >= 200 && response.status < 300 : accepted.includes(response.status);
    if (!statusOk) return { ok: false, status: response.status, error: `HTTP ${String(response.status)}`, checkedAt };
    if (probe.expectBody !== void 0 && !(await response.text()).includes(probe.expectBody)) {
      return { ok: false, status: response.status, error: `body missing "${probe.expectBody}"`, checkedAt };
    }
    return { ok: true, status: response.status, checkedAt };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), checkedAt };
  }
}
var ANTHROPIC_VERSION = "2023-06-01";
var MODEL_LISTING_TIMEOUT_MS = 15e3;
var MODEL_LISTING_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
function modelListingUrl(baseURL, api) {
  const base = baseURL.replace(/\/+$/, "");
  if (api !== "anthropic-messages") return `${base}/models`;
  const root = base.endsWith("/v1") ? base.slice(0, -3) : base;
  return `${root}/v1/models?limit=1000`;
}
function listingDescriptionNames(body) {
  const names = /* @__PURE__ */ new Map();
  const rows = [];
  if (Array.isArray(body)) {
    for (const raw of body) rows.push({ raw });
  } else if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const listing = body;
    if (Array.isArray(listing.data)) {
      for (const raw of listing.data) rows.push({ raw });
    } else if (Array.isArray(listing.models)) {
      for (const raw of listing.models) rows.push({ raw });
    } else if (listing.models !== null && typeof listing.models === "object") {
      for (const [key, raw] of Object.entries(listing.models)) rows.push({ key, raw });
    }
  }
  for (const { key, raw } of rows) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw;
    const id = listingText(key, entry.id, entry.slug);
    if (id === void 0) continue;
    const name2 = listingText(entry.name, entry.displayName, entry.display_name, entry.description);
    if (name2 === void 0 || name2 === id || names.has(id)) continue;
    names.set(id, name2);
  }
  return names;
}
function discoveredFromListing(model, descriptionName) {
  const name2 = model.name ?? descriptionName;
  return {
    id: model.id,
    ...name2 === void 0 || name2 === model.id ? {} : { name: name2 },
    ...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
    ...model.maxInputTokens === void 0 ? {} : { maxInputTokens: model.maxInputTokens },
    ...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
    ...model.inputModalities === void 0 || model.inputModalities.length === 0 ? {} : { input: [...model.inputModalities] },
    ...model.tools === void 0 ? {} : { tools: model.tools },
    ...model.reasoning === void 0 ? {} : { reasoning: model.reasoning },
    ...model.reasoningEfforts === void 0 ? {} : { reasoningEfforts: { ...model.reasoningEfforts } }
  };
}
function discoveredFromEntry(model) {
  if (model.id === "") return void 0;
  const input = (model.inputModalities ?? []).filter((modality) => typeof modality === "string" && modality !== "");
  return {
    id: model.id,
    ...model.name === void 0 || model.name === model.id ? {} : { name: model.name },
    ...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
    ...model.maxInputTokens === void 0 ? {} : { maxInputTokens: model.maxInputTokens },
    ...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
    ...input.length === 0 ? {} : { input },
    ...model.tools === void 0 ? {} : { tools: model.tools },
    ...model.reasoning === void 0 ? {} : { reasoning: model.reasoning },
    ...model.reasoningEfforts === void 0 ? {} : model.reasoningEfforts === false ? { reasoningEfforts: false } : { reasoningEfforts: { ...model.reasoningEfforts } }
  };
}
function sanitizedDiscoveryError(error, apiKey) {
  const raw = error instanceof Error ? error.name === "TimeoutError" ? "listing request timed out" : error.message : String(error);
  const redacted = apiKey === void 0 || apiKey === "" ? raw : raw.split(apiKey).join("[redacted]");
  return redacted.replace(/https?:\/\/\S+/gu, "[endpoint]").slice(0, 300);
}
async function readBoundedListingBody(response) {
  const oversized = `listing response exceeds ${String(MODEL_LISTING_MAX_RESPONSE_BYTES)} bytes`;
  const declared = Number(response.headers?.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MODEL_LISTING_MAX_RESPONSE_BYTES) {
    return { ok: false, error: oversized };
  }
  const body = response.body;
  if (body === void 0 || body === null) {
    const text2 = await response.text();
    return Buffer.byteLength(text2, "utf8") > MODEL_LISTING_MAX_RESPONSE_BYTES ? { ok: false, error: oversized } : { ok: true, text: text2 };
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === void 0) continue;
    total += value.byteLength;
    if (total > MODEL_LISTING_MAX_RESPONSE_BYTES) {
      if (reader.cancel !== void 0) {
        await reader.cancel().catch(() => {
        });
      }
      return { ok: false, error: oversized };
    }
    chunks.push(value);
  }
  if (reader.cancel !== void 0) {
    await reader.cancel().catch(() => {
    });
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}
async function discoverModelListing(baseURL, apiKey, fetchImpl = globalThis.fetch, api) {
  const url = modelListingUrl(baseURL, api);
  const headers = { accept: "application/json" };
  if (api === "anthropic-messages") {
    headers["anthropic-version"] = ANTHROPIC_VERSION;
    if (apiKey !== void 0 && apiKey.length > 0) headers["x-api-key"] = apiKey;
  } else if (apiKey !== void 0 && apiKey.length > 0) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(MODEL_LISTING_TIMEOUT_MS) });
    const status = response.status;
    if (!response.ok) {
      return {
        state: status === 401 || status === 403 ? "unauthorized" : "failed",
        models: [],
        status,
        error: `HTTP ${String(status)}`
      };
    }
    const bounded = await readBoundedListingBody(response);
    if (!bounded.ok) return { state: "failed", models: [], status, error: bounded.error };
    let body;
    try {
      body = JSON.parse(bounded.text);
    } catch {
      return { state: "failed", models: [], status, error: "listing response is not JSON" };
    }
    const parsed = readModelListing(body);
    if (!parsed.ok) {
      return { state: "failed", models: [], status, error: "listing response is not a model listing" };
    }
    const names = listingDescriptionNames(body);
    const seen = /* @__PURE__ */ new Set();
    const models = [];
    for (const model of parsed.models) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(discoveredFromListing(model, names.get(model.id)));
    }
    return { state: models.length === 0 ? "empty" : "fresh", models, status };
  } catch (error) {
    return { state: "failed", models: [], error: sanitizedDiscoveryError(error, apiKey) };
  }
}
async function discoverNamespaceModels(deps, manifest, baseURL, apiKey) {
  const llm = deps.llm;
  if (llm === void 0) return { state: "failed", models: [], error: "no model discovery is registered" };
  try {
    const found = await llm.discoverModels(routeSettingsNs(manifest), {
      provider: manifest.id,
      baseURL,
      api: manifest.protocol,
      ...apiKey === void 0 || apiKey.length === 0 ? {} : { apiKey }
    });
    const models = [];
    for (const entry of found) {
      const model = discoveredFromEntry(entry);
      if (model !== void 0) models.push(model);
    }
    return { state: models.length === 0 ? "empty" : "fresh", models };
  } catch (error) {
    return { state: "failed", models: [], error: sanitizedDiscoveryError(error, apiKey) };
  }
}
async function resolveStoredCredential(deps, ref) {
  if (deps.credentials === void 0) return void 0;
  try {
    const value = (await deps.credentials.resolve(ref))?.value?.trim();
    return value === void 0 || value === "" ? void 0 : value;
  } catch {
    return void 0;
  }
}
async function resolveRouteKey(deps, manifest, supplied) {
  const explicit = supplied?.trim();
  if (explicit !== void 0 && explicit !== "") return explicit;
  if (manifest.auth.kind !== "unified") return void 0;
  const ref = manifest.auth.apiKeyEnv;
  return ref === void 0 ? void 0 : resolveStoredCredential(deps, ref);
}
async function discoverServiceCatalog(deps, manifest, baseURL, apiKey, options = {}) {
  if (manifest.delivery === "direct" || manifest.settingsNs !== void 0) {
    return { ...await discoverNamespaceModels(deps, manifest, baseURL, apiKey), source: "namespace" };
  }
  let key = apiKey;
  const ref = manifest.auth.kind === "unified" ? manifest.auth.apiKeyEnv : void 0;
  if (key === void 0 && options.resolveStoredCredential !== false && ref !== void 0 && deps.credentials !== void 0) {
    key = await resolveStoredCredential(deps, ref);
  }
  return { ...await discoverModelListing(baseURL, key, deps.fetchImpl, manifest.protocol), source: "endpoint" };
}
function revisionOf(settings, ns) {
  return settings.describe?.().find((entry) => entry.ns === ns)?.revision;
}
function namespaceSnapshot(settings, ns) {
  const entry = settings.describe?.().find((candidate) => candidate.ns === ns);
  return entry === void 0 ? void 0 : { ...entry.revision === void 0 ? {} : { revision: entry.revision }, ...entry.value === void 0 ? {} : { value: entry.value } };
}
function readNamespace(settings, ns) {
  const value = settings?.describe?.().find((entry) => entry.ns === ns)?.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
  return value;
}
function routeSettingsNs(manifest) {
  return manifest.settingsNs ?? LLM_NS;
}
function pendingRestartMessage(ns) {
  return `Available after the next restart \u2014 the "${ns}" settings namespace is not registered in the running profile yet (build the profile, then restart the service).`;
}
function settingsNamespaceReady(deps, ns) {
  const settings = deps.settings;
  if (settings === void 0 || settings.describe === void 0) return void 0;
  return settings.describe().some((entry) => entry.ns === ns);
}
function pendingRestartForManifest(deps, manifest) {
  const ns = routeSettingsNs(manifest);
  return settingsNamespaceReady(deps, ns) === false ? { ns, message: pendingRestartMessage(ns) } : void 0;
}
function configuredProfile(deps, id, settingsNs = LLM_NS) {
  const section = readNamespace(deps.settings, settingsNs);
  const providers = section?.providers;
  if (providers === null || typeof providers !== "object" || Array.isArray(providers)) return void 0;
  const profile = providers[id];
  if (profile === null || typeof profile !== "object" || Array.isArray(profile)) return void 0;
  return profile;
}
async function writeRoute(deps, manifest, mode, models, overrides = {}) {
  const settings = deps.settings;
  if (settings === void 0) throw new Error("settings seam absent \u2014 cannot write the route");
  const pending = pendingRestartForManifest(deps, manifest);
  if (pending !== void 0) throw new Error(pending.message);
  const profile = routeProfile(manifest, mode, models, overrides);
  const settingsNs = routeSettingsNs(manifest);
  await settings.mutate(
    settingsNs,
    [{ op: "set", path: ["providers", manifest.id], value: profile }],
    overrides.expectedRevision ?? revisionOf(settings, settingsNs)
  );
  return profile;
}
async function storeCredential(deps, manifest, key) {
  const ref = manifest.pool?.identities[0]?.credentialRef ?? manifest.auth.apiKeyEnv;
  if (key === void 0 || key.trim() === "" || ref === void 0) return false;
  const credentials = deps.credentials;
  if (credentials === void 0) throw new Error("credentials seam absent \u2014 cannot store the key");
  await credentials.set(ref, key.trim());
  return true;
}
async function commitRoute(deps, manifest, mode, models, key, overrides = {}) {
  if (deps.settings === void 0) throw new Error("settings seam absent \u2014 cannot write the route");
  const pending = pendingRestartForManifest(deps, manifest);
  if (pending !== void 0) throw new Error(pending.message);
  const credentials = deps.credentials;
  const ref = manifest.pool?.identities[0]?.credentialRef ?? manifest.auth.apiKeyEnv;
  const value = key?.trim() ?? "";
  const store = value !== "" && ref !== void 0;
  const keyless = manifest.auth.kind === "none" ? true : store ? false : overrides.keyless;
  let previous;
  if (store) {
    if (credentials === void 0) throw new Error("credentials seam absent \u2014 cannot store the key");
    previous = await credentials.resolve(ref);
    await credentials.set(ref, value);
  }
  const writeOverrides = {
    ...overrides.baseURL === void 0 ? {} : { baseURL: overrides.baseURL },
    ...overrides.catalogAuthority === void 0 ? {} : { catalogAuthority: overrides.catalogAuthority },
    ...overrides.catalogState === void 0 ? {} : { catalogState: overrides.catalogState },
    ...keyless === void 0 ? {} : { keyless }
  };
  let route;
  try {
    const settingsNs = routeSettingsNs(manifest);
    for (let attempt = 0; attempt < MAX_SETTINGS_WRITE_ATTEMPTS; attempt += 1) {
      let expectedRevision;
      if (overrides.refuseExisting === true) {
        const snapshot = namespaceSnapshot(deps.settings, settingsNs);
        const section = isPlainRecord(snapshot?.value) ? snapshot.value : void 0;
        const providers = isPlainRecord(section?.providers) ? section.providers : void 0;
        if (providers !== void 0 && Object.hasOwn(providers, manifest.id)) {
          throw new Error(
            `provider "${manifest.id}" received a route while the install was running; the install refused to overwrite it (remove or retry deliberately)`
          );
        }
        expectedRevision = snapshot?.revision;
      }
      try {
        route = await writeRoute(deps, manifest, mode, models, {
          ...writeOverrides,
          ...expectedRevision === void 0 ? {} : { expectedRevision }
        });
        break;
      } catch (error) {
        if (isSettingsConflict(error) && attempt < MAX_SETTINGS_WRITE_ATTEMPTS - 1) continue;
        throw error;
      }
    }
    if (route === void 0) throw new Error("route commit exhausted its settings attempts");
  } catch (error) {
    if (store && credentials !== void 0) {
      try {
        if (previous?.value !== void 0) await credentials.set(ref, previous.value);
        else await credentials.unset(ref);
      } catch (rollbackError) {
        const cause = error instanceof Error ? error.message : String(error);
        const failed2 = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(`${cause} (credential rollback also failed: ${failed2})`);
      }
    }
    throw error;
  }
  return { route, credentialStored: store };
}
async function useDetectedInstance(deps, manifest, key, options = {}) {
  const direct = manifest.delivery === "direct";
  const typedOrigin = options.baseURL === void 0 ? void 0 : instanceBaseURLFromInput(options.baseURL);
  if (options.baseURL !== void 0 && typedOrigin === void 0) {
    throw new Error("invalid custom instance base URL");
  }
  const customBase = typedOrigin === void 0 ? void 0 : `${typedOrigin}${urlPath(manifest.reuse.baseURL)}`;
  const profile = configuredProfile(deps, manifest.id, routeSettingsNs(manifest));
  const configuredBase = typeof profile?.baseURL === "string" ? profile.baseURL : void 0;
  const detection = direct || customBase !== void 0 ? void 0 : await detectInstance(deps, manifest, configuredBase);
  if (!direct && customBase === void 0 && detection?.ok !== true) {
    throw new Error(`no running ${manifest.label} instance was detected \u2014 start it, install it locally, or enter a custom instance address`);
  }
  const endpoint = direct ? manifest.reuse.baseURL : customBase ?? (detection.ok ? detection.baseURL : manifest.reuse.baseURL);
  let effectiveKey = await resolveRouteKey(deps, manifest, key);
  let recoveredKey;
  const operatorKey = key?.trim() ?? "";
  if (effectiveKey === void 0 && operatorKey === "" && ownsLocalInstall(lifecycleOf(deps.dshHome, manifest.id))) {
    const readable = (await deps.readInstallCredential?.(manifest.id))?.trim();
    if (readable !== void 0 && readable !== "") {
      effectiveKey = readable;
      recoveredKey = readable;
    }
  }
  const catalog = await discoverServiceCatalog(deps, manifest, endpoint, effectiveKey, { resolveStoredCredential: false });
  const models = catalog.models;
  const rawHealth = direct ? await probeHealth(manifest.reuse.health, deps.fetchImpl) : typedOrigin !== void 0 ? await probeHealth(healthForBase(manifest, typedOrigin), deps.fetchImpl) : detection.health;
  const health = { ...rawHealth, reachable: reachable(rawHealth) };
  const wouldBeAnonymous = manifest.auth.kind === "none" || effectiveKey === void 0 && manifest.auth.keyless;
  if (catalog.state === "unauthorized" && effectiveKey === void 0 && wouldBeAnonymous) {
    throw new Error(
      `${manifest.label} answered at ${endpoint} but requires authorization (HTTP ${String(health.status ?? "401/403")}); enter the instance key and retry, or check its access configuration`
    );
  }
  const suppliedKey = operatorKey !== "" ? operatorKey : recoveredKey;
  const keyless = manifest.auth.kind === "unified" && effectiveKey !== void 0 ? false : void 0;
  if (catalog.state === "empty") writeKnownEmptyDiscoveredEntry(deps, manifest.id, endpoint);
  const { route, credentialStored } = await commitRoute(deps, manifest, "reuse", models, suppliedKey, {
    baseURL: endpoint,
    catalogState: catalog.state,
    ...keyless === void 0 ? {} : { keyless }
  });
  const existingLifecycle = lifecycleOf(deps.dshHome, manifest.id);
  const isReconnectingToLocalInstall = options.baseURL === void 0 && endpoint === manifest.local.baseURL && ownsLocalInstall(existingLifecycle);
  if (!isReconnectingToLocalInstall) {
    recordReuseLifecycle(deps.dshHome, manifest.id, {
      setupKind: options.baseURL !== void 0 ? "custom-instance" : "detected-instance",
      endpoint
    });
  }
  const customPort = typedOrigin === void 0 ? void 0 : urlPort(typedOrigin);
  return {
    route,
    health,
    models,
    catalog,
    credentialStored,
    ...detection?.ok === true && detection.port !== void 0 ? { port: detection.port } : customPort === void 0 ? {} : { port: customPort },
    endpoint
  };
}
function discoveredCachePath(deps) {
  const override = process.env.DSH_DISCOVERED_MODELS;
  if (override !== void 0 && override.length > 0) return override;
  return join4(deps.dshHome, "cache", "discovered-models.json");
}
function removeDiscoveredEntry(deps, id) {
  const path = discoveredCachePath(deps);
  if (!existsSync(path)) return false;
  try {
    const document = JSON.parse(readFileSync4(path, "utf8"));
    const routes = document.routes;
    if (routes === null || typeof routes !== "object" || routes === void 0) return false;
    if (!(id in routes)) return false;
    delete routes[id];
    mkdirSync4(dirname2(path), { recursive: true });
    const temporary = `${path}.tmp-${String(process.pid)}`;
    writeFileSync4(temporary, JSON.stringify(document), "utf8");
    renameSync3(temporary, path);
    return true;
  } catch {
    return false;
  }
}
var DISCOVERED_CACHE_VERSION = 1;
function writeKnownEmptyDiscoveredEntry(deps, id, baseURL, now = Date.now) {
  const path = discoveredCachePath(deps);
  let document = { version: DISCOVERED_CACHE_VERSION, routes: {} };
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync4(path, "utf8"));
      if (isPlainRecord(parsed) && parsed.version === DISCOVERED_CACHE_VERSION && isPlainRecord(parsed.routes)) {
        document = { version: DISCOVERED_CACHE_VERSION, routes: { ...parsed.routes } };
      }
    } catch {
    }
  }
  document.routes[id] = { baseURL, fetchedAt: now(), models: [] };
  mkdirSync4(dirname2(path), { recursive: true });
  const temporary = `${path}.tmp-${String(process.pid)}`;
  try {
    writeFileSync4(temporary, JSON.stringify(document), "utf8");
    renameSync3(temporary, path);
  } catch (error) {
    rmSync3(temporary, { force: true });
    throw error;
  }
}
function removePoolState(deps, id) {
  const path = join4(deps.dshHome, "pools", `${id}.json`);
  if (!existsSync(path)) return false;
  try {
    rmSync3(path);
    return true;
  } catch {
    return false;
  }
}
function linkReferences(link, id) {
  return link !== null && typeof link === "object" && link.provider === id;
}
function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
var MAX_SETTINGS_WRITE_ATTEMPTS = 3;
function isSettingsConflict(error) {
  return error !== null && typeof error === "object" && error.code === "SETTINGS_CONFLICT";
}
async function applySettingsPlan(settings, ns, plan) {
  let lastError;
  for (let attempt = 0; attempt < MAX_SETTINGS_WRITE_ATTEMPTS; attempt += 1) {
    const planned = plan(readNamespace(settings, ns));
    if (planned.ops.length === 0) return { committed: false, result: planned.result };
    try {
      await settings.mutate(ns, planned.ops, revisionOf(settings, ns));
      return { committed: true, result: planned.result };
    } catch (error) {
      lastError = error;
      if (!isSettingsConflict(error) || attempt === MAX_SETTINGS_WRITE_ATTEMPTS - 1) throw error;
    }
  }
  throw lastError;
}
function planOrchestrationCleanup(document, id) {
  const ops = [];
  const rewritten = [];
  const droppedChains = /* @__PURE__ */ new Set();
  let chainLinksRemoved = 0;
  const chains = document?.chains;
  if (isPlainRecord(chains)) {
    for (const [chainId, raw] of Object.entries(chains)) {
      if (!isPlainRecord(raw)) continue;
      const links = Array.isArray(raw.links) ? raw.links : [];
      const kept = links.filter((link) => !linkReferences(link, id));
      if (kept.length === links.length) continue;
      chainLinksRemoved += links.length - kept.length;
      const selectors = Array.isArray(raw.selectors) ? raw.selectors : [];
      if (kept.length === 0 && selectors.length === 0) {
        ops.push({ op: "unset", path: ["chains", chainId] });
        droppedChains.add(chainId);
        rewritten.push(`chains.${chainId}: dropped (last link removed)`);
        continue;
      }
      ops.push({ op: "set", path: ["chains", chainId], value: { ...raw, links: kept } });
      rewritten.push(`chains.${chainId}: dropped ${String(links.length - kept.length)} link(s)`);
    }
  }
  const personas = document?.personas;
  if (isPlainRecord(personas)) {
    for (const [seat, raw] of Object.entries(personas)) {
      if (!isPlainRecord(raw)) continue;
      const chain = typeof raw.chain === "string" && raw.chain !== "" ? raw.chain : void 0;
      const namesRoute = raw.provider === id;
      const namesDroppedChain = chain !== void 0 && droppedChains.has(chain);
      if (!namesRoute && !namesDroppedChain) continue;
      ops.push({ op: "set", path: ["personas", seat], value: null });
      rewritten.push(`personas.${seat}: reset to inherit`);
    }
  }
  const preferences = document?.uiPreferences;
  if (isPlainRecord(preferences)) {
    const favorites = Array.isArray(preferences.favorites) ? preferences.favorites : void 0;
    if (favorites !== void 0) {
      const kept = favorites.filter((entry) => !(isPlainRecord(entry) && entry.provider === id));
      if (kept.length !== favorites.length) {
        ops.push({ op: "set", path: ["uiPreferences", "favorites"], value: kept });
        rewritten.push("uiPreferences.favorites: pruned");
      }
    }
    const hidden = preferences.hiddenModels;
    if (isPlainRecord(hidden) && Object.hasOwn(hidden, id)) {
      const next = { ...hidden };
      delete next[id];
      ops.push({ op: "set", path: ["uiPreferences", "hiddenModels"], value: next });
      rewritten.push("uiPreferences.hiddenModels: pruned");
    }
    const order = Array.isArray(preferences.providerOrder) ? preferences.providerOrder : void 0;
    if (order !== void 0) {
      const kept = order.filter((entry) => entry !== id);
      if (kept.length !== order.length) {
        ops.push({ op: "set", path: ["uiPreferences", "providerOrder"], value: kept });
        rewritten.push("uiPreferences.providerOrder: pruned");
      }
    }
  }
  return { ops, chainLinksRemoved, rewritten, droppedChains };
}
var DEFAULT_BASELINE_PROVIDER = "kilo";
var DEFAULT_BASELINE_MODEL = "poolside/laguna-s-2.1:free";
function planDefaultModelCleanup(document, id, droppedChains) {
  if (document === void 0) return { ops: [], rewritten: [] };
  const ops = [];
  const rewritten = [];
  const chain = typeof document.chain === "string" && document.chain !== "" ? document.chain : void 0;
  if (chain !== void 0 && droppedChains.has(chain)) {
    ops.push({ op: "unset", path: ["chain"] });
    rewritten.push("agent-default-model.chain: dropped");
  }
  if (document.provider !== id) return { ops, rewritten };
  const baseline = document.baseline === "off" ? "off" : "kilo";
  ops.push(
    { op: "set", path: ["provider"], value: baseline === "off" ? "" : DEFAULT_BASELINE_PROVIDER },
    { op: "set", path: ["model"], value: baseline === "off" ? "" : DEFAULT_BASELINE_MODEL }
  );
  rewritten.push("agent-default-model: reset");
  return { ops, rewritten };
}
var AGENT_DEFAULT_MODEL_NS = "agent-default-model";
var SUBAGENT_MODEL_SELECTION_NS = "subagent-model-selection-settings";
var LEGACY_SUBAGENT_MODEL_SELECTION_NS = "subagent-model-selection";
function planSubagentCleanup(document, id) {
  if (document === void 0) return { ops: [], rewritten: [] };
  const allowed = Array.isArray(document.allowedModels) ? document.allowedModels : void 0;
  if (allowed === void 0) return { ops: [], rewritten: [] };
  const kept = allowed.filter((entry) => !(isPlainRecord(entry) && entry.provider === id));
  if (kept.length === allowed.length) return { ops: [], rewritten: [] };
  const ops = [{ op: "set", path: ["allowedModels"], value: kept }];
  if (kept.length === 0 && document.enabled === true) ops.push({ op: "set", path: ["enabled"], value: false });
  return { ops, rewritten: ["subagent-model-selection: pruned"] };
}
async function removeRouteReferences(deps, id) {
  const settings = deps.settings;
  if (settings === void 0) return { chainLinksRemoved: 0, rewritten: [], errors: [] };
  const rewritten = [];
  const errors = [];
  let chainLinksRemoved = 0;
  let droppedChains = /* @__PURE__ */ new Set();
  try {
    const outcome = await applySettingsPlan(settings, ORCHESTRATION_NS, (document) => {
      const planned = planOrchestrationCleanup(document, id);
      return { ops: planned.ops, result: planned };
    });
    chainLinksRemoved = outcome.result.chainLinksRemoved;
    droppedChains = outcome.result.droppedChains;
    rewritten.push(...outcome.result.rewritten);
  } catch (error) {
    errors.push(`references (${ORCHESTRATION_NS}): ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const outcome = await applySettingsPlan(settings, AGENT_DEFAULT_MODEL_NS, (document) => {
      const planned = planDefaultModelCleanup(document, id, droppedChains);
      return { ops: planned.ops, result: planned.rewritten };
    });
    rewritten.push(...outcome.result);
  } catch (error) {
    errors.push(`references (${AGENT_DEFAULT_MODEL_NS}): ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const ns of [SUBAGENT_MODEL_SELECTION_NS, LEGACY_SUBAGENT_MODEL_SELECTION_NS]) {
    if (readNamespace(settings, ns) === void 0) continue;
    try {
      const outcome = await applySettingsPlan(settings, ns, (document) => {
        const planned = planSubagentCleanup(document, id);
        return { ops: planned.ops, result: planned.rewritten };
      });
      rewritten.push(...outcome.result);
    } catch (error) {
      errors.push(`references (${ns}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { chainLinksRemoved, rewritten, errors };
}
function credentialRefInUse(deps, manifest, ref) {
  const entries = deps.settings?.describe?.();
  if (entries === void 0) return false;
  const removedNs = routeSettingsNs(manifest);
  for (const entry of entries) {
    const value = entry.value;
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const providers = value.providers;
    if (providers === null || typeof providers !== "object" || Array.isArray(providers)) continue;
    for (const [id, raw] of Object.entries(providers)) {
      if (entry.ns === removedNs && id === manifest.id) continue;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const route = raw;
      if (route.apiKeyEnv === ref) return true;
      const pool = route.pool;
      if (pool === null || typeof pool !== "object" || Array.isArray(pool)) continue;
      const identities = pool.identities;
      if (!Array.isArray(identities)) continue;
      if (identities.some((identity) => identity !== null && typeof identity === "object" && !Array.isArray(identity) && identity.credentialRef === ref)) return true;
    }
  }
  return false;
}
function routeCredentialRefs(manifest, profile) {
  const refs = /* @__PURE__ */ new Set();
  const add = (value) => {
    if (typeof value === "string" && value !== "") refs.add(value);
  };
  add(manifest.auth.apiKeyEnv);
  for (const identity of manifest.pool?.identities ?? []) add(identity.credentialRef);
  if (profile !== void 0) {
    add(profile.apiKeyEnv);
    const pool = profile.pool;
    if (isPlainRecord(pool) && Array.isArray(pool.identities)) {
      for (const identity of pool.identities) {
        if (isPlainRecord(identity)) add(identity.credentialRef);
      }
    }
  }
  return [...refs];
}
function lockRefusal(error) {
  if (error === null || typeof error !== "object") return void 0;
  const name2 = error.name;
  if (name2 !== "HeavyProviderLockedError" && name2 !== "HeavyProviderLockUnreadableError") return void 0;
  return {
    reason: error instanceof Error ? error.message : String(error),
    lock: name2 === "HeavyProviderLockedError" ? "held" : "unreadable"
  };
}
function refusedRemoval(reason, lock) {
  return {
    routeRemoved: false,
    credentialRemoved: false,
    poolStateRemoved: false,
    cacheEntryRemoved: false,
    chainLinksRemoved: 0,
    teardown: { ran: false, ok: false, output: "" },
    warnings: [],
    errors: [`lock: ${reason}`],
    blocked: { reason, lock }
  };
}
async function runTeardown(deps, manifest) {
  let output = "";
  let ok = true;
  let failedStep;
  for (const step of manifest.removal.steps) {
    try {
      const outcome = await deps.runStep(step);
      output += `$ ${step.label}
${outcome.output}
`;
      if (outcome.exitCode !== 0 && step.optional !== true) {
        ok = false;
        failedStep = step.label;
        break;
      }
    } catch (error) {
      if (step.optional === true) {
        output += `$ ${step.label} (optional, failed: ${error instanceof Error ? error.message : String(error)})
`;
        continue;
      }
      ok = false;
      failedStep = step.label;
      output += `$ ${step.label} (failed: ${error instanceof Error ? error.message : String(error)})
`;
      break;
    }
  }
  return { ran: true, ok, ...failedStep === void 0 ? {} : { failedStep }, output };
}
async function removeProviderLocked(deps, manifest, options) {
  const warnings = [];
  const errors = [];
  const lifecycle = lifecycleOf(deps.dshHome, manifest.id);
  const owned = ownsLocalInstall(lifecycle);
  const settingsNs = routeSettingsNs(manifest);
  const profile = configuredProfile(deps, manifest.id, settingsNs);
  const credentialRefs = routeCredentialRefs(manifest, profile);
  let routeRemoved = false;
  if (deps.settings !== void 0 && profile !== void 0) {
    try {
      await applySettingsPlan(deps.settings, settingsNs, () => ({
        ops: [{ op: "unset", path: ["providers", manifest.id] }],
        result: void 0
      }));
      routeRemoved = true;
    } catch (error) {
      errors.push(`route: ${error instanceof Error ? error.message : String(error)}`);
      return {
        routeRemoved: false,
        credentialRemoved: false,
        poolStateRemoved: false,
        cacheEntryRemoved: false,
        chainLinksRemoved: 0,
        teardown: { ran: false, ok: true, output: "" },
        warnings,
        errors,
        referencesRemoved: []
      };
    }
  }
  let teardown = { ran: false, ok: true, output: "" };
  if (options.uninstall === true) {
    if (!owned) {
      if (manifest.removal.steps.length > 0) {
        warnings.push(
          `local teardown skipped for ${manifest.id}: no verified harness ownership receipt; the vendor service was not touched`
        );
      }
    } else if (manifest.removal.steps.length > 0) {
      teardown = await runTeardown(deps, manifest);
      if (!teardown.ok) warnings.push(`local install kept: teardown did not complete, lifecycle record preserved for retry`);
    }
  }
  const retainOwnedCredential = owned && options.uninstall !== true;
  let credentialRemoved = false;
  if (retainOwnedCredential) {
    if (credentialRefs.length > 0) {
      warnings.push(
        `credential ${credentialRefs.join(", ")} kept: ${manifest.id} is still an owned local install (remove with uninstall to run its teardown); the generated key is required to re-add it`
      );
    }
  } else if (deps.credentials !== void 0) {
    for (const ref of credentialRefs) {
      if (credentialRefInUse(deps, manifest, ref)) {
        warnings.push(`credential ${ref} kept: another configured route references it`);
        continue;
      }
      try {
        await deps.credentials.unset(ref);
        credentialRemoved = true;
      } catch (error) {
        errors.push(`credential ${ref}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const poolStateRemoved = removePoolState(deps, manifest.id);
  const cacheEntryRemoved = removeDiscoveredEntry(deps, manifest.id);
  const references = await removeRouteReferences(deps, manifest.id);
  errors.push(...references.errors);
  try {
    if (lifecycle !== void 0) {
      const uninstalled = owned && options.uninstall === true && teardown.ok;
      const reused = lifecycle.mode === "reuse";
      if (uninstalled || reused) {
        if (uninstalled) {
          await deps.clearInstallReceipt?.(manifest.id);
        }
        clearProviderLifecycle(deps.dshHome, manifest.id);
      } else if (owned && options.uninstall !== true) {
        warnings.push(`local install left in place: ${manifest.id} is still owned by this harness; remove with uninstall to run its teardown`);
      }
    }
  } catch (error) {
    errors.push(`state: ${error instanceof Error ? error.message : String(error)}`);
  }
  const evicted = deps.jobs?.evict(manifest.id) ?? true;
  if (!evicted) warnings.push(`job snapshot for ${manifest.id} kept: a live owner still holds it`);
  return {
    routeRemoved,
    credentialRemoved,
    poolStateRemoved,
    cacheEntryRemoved,
    chainLinksRemoved: references.chainLinksRemoved,
    teardown,
    warnings,
    errors,
    referencesRemoved: references.rewritten
  };
}
async function removeProvider(deps, manifest, options = {}) {
  const jobs = deps.jobs;
  if (jobs?.withProviderLock !== void 0) {
    try {
      return await jobs.withProviderLock(manifest.id, () => removeProviderLocked(deps, manifest, options));
    } catch (error) {
      const refusal = lockRefusal(error);
      if (refusal === void 0) throw error;
      return refusedRemoval(refusal.reason, refusal.lock);
    }
  }
  const dir = join4(deps.dshHome, "cache", "heavy-jobs");
  let lock;
  try {
    lock = acquireProviderLock(dir, manifest.id);
  } catch (error) {
    const refusal = lockRefusal(error);
    if (refusal === void 0) throw error;
    return refusedRemoval(refusal.reason, refusal.lock);
  }
  try {
    const fallbackJobs = {
      evict: deps.jobs?.evict ?? ((id) => {
        try {
          rmSync3(join4(dir, `${id}.json`), { force: true });
          return true;
        } catch {
          return false;
        }
      }),
      isRunning: deps.jobs?.isRunning ?? (() => false),
      withProviderLock: async (_id, operation) => operation()
    };
    return await removeProviderLocked({ ...deps, jobs: fallbackJobs }, manifest, options);
  } finally {
    lock.release();
  }
}

// src/remote.ts
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

// src/locales.ts
function hostLocale(env = process.env) {
  const tag = env.DSH_LOCALE ?? env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? "";
  return /^zh\b/i.test(tag.replaceAll("_", "-")) ? "zh" : "en";
}
function localeFromPreference(preference, env = process.env) {
  if (typeof preference !== "string" || preference === "") return hostLocale(env);
  return /^zh\b/i.test(preference.replaceAll("_", "-")) ? "zh" : "en";
}
function settingsLocale(settings, env = process.env) {
  try {
    const value = settings?.describeNamespace?.("locale")?.value ?? settings?.describe?.().find((entry) => entry.ns === "locale")?.value;
    const preference = value !== null && typeof value === "object" ? value.preference : void 0;
    return localeFromPreference(preference, env);
  } catch {
    return hostLocale(env);
  }
}
var zh = {
  "summary.freellmapi": "\u81EA\u6258\u7BA1\u514D\u8D39\u989D\u5EA6\u7F51\u5173\uFF1A\u7EA6 30 \u4E2A\u63D0\u4F9B\u65B9\u5171\u7528\u4E00\u4E2A OpenAI \u517C\u5BB9\u7AEF\u70B9\u3002",
  "summary.antigravity": "\u9762\u5411 Google Antigravity OAuth \u8D26\u53F7\u7684\u591A\u8D26\u53F7 Anthropic \u517C\u5BB9\u4EE3\u7406\u3002",
  "summary.commandcode": "api.commandcode.ai \u4E0A CLI \u5F62\u6001\u7684 Command Code API\uFF0C\u7531 DSH \u63D0\u4F9B\u65B9\u5305\u53CA\u5176\u539F\u751F\u591A\u5BC6\u94A5\u6C60\u670D\u52A1\u2014\u2014\u65E0\u9700\u4EE3\u7406\u3002",
  "detected.label": "\u4F7F\u7528\u68C0\u6D4B\u5230\u7684\u5B9E\u4F8B",
  "reuse.freellmapi.label": "\u4F7F\u7528\u68C0\u6D4B\u5230\u7684\u5B9E\u4F8B",
  "reuse.freellmapi.note": "\u96F6\u5B89\u88C5\uFF1A\u4F7F\u7528\u672C\u673A\u5DF2\u5728\u8FD0\u884C\u7684 FreeLLMAPI \u5B9E\u4F8B\u3002",
  "reuse.antigravity.label": "\u4F7F\u7528\u68C0\u6D4B\u5230\u7684\u5B9E\u4F8B",
  "reuse.antigravity.note": "\u96F6\u5B89\u88C5\uFF1A\u4F7F\u7528\u672C\u673A\u5DF2\u5728\u8FD0\u884C\u7684\u4EE3\u7406\u5B9E\u4F8B\u53CA\u5176\u5DF2\u914D\u7F6E\u7684\u8D26\u53F7\u6C60\u3002",
  "reuse.commandcode.label": "\u7ACB\u5373\u4F7F\u7528\u5382\u5546\u7AEF\u70B9",
  "reuse.commandcode.note": "\u786E\u8BA4\u7AEF\u70B9\u53EF\u5E94\u7B54\u540E\u628A\u8DEF\u7531\u5199\u5230\u5382\u5546\u7AEF\u70B9\uFF1B\u63D0\u4F9B\u65B9\u5305\u5C1A\u672A\u94FE\u63A5\u65F6\u8BF7\u5148\u8FD0\u884C\u672C\u5730\u8BBE\u7F6E\u3002",
  "local.freellmapi.label": "\u672C\u5730\u5B89\u88C5\uFF08Docker \u6216 Podman\uFF09",
  "local.freellmapi.darwin.label": "\u672C\u5730\u5B89\u88C5\uFF08\u5382\u5546\u684C\u9762\u5E94\u7528\uFF0C\u65E0\u9700 Docker\uFF09",
  "local.freellmapi.win32.label": "\u672C\u5730\u5B89\u88C5\uFF08\u5382\u5546\u684C\u9762\u5E94\u7528\uFF0C\u65E0\u9700 Docker\uFF09",
  "local.antigravity.label": "\u672C\u5730\u5B89\u88C5\uFF08npm + \u7528\u6237\u670D\u52A1\uFF09",
  "local.antigravity.linux.label": "\u672C\u5730\u5B89\u88C5\uFF08npm + systemd \u7528\u6237\u5355\u5143\uFF09",
  "local.antigravity.darwin.label": "\u672C\u5730\u5B89\u88C5\uFF08npm + launchd \u4EE3\u7406\uFF09",
  "local.antigravity.win32.label": "Windows \u4E0D\u652F\u6301",
  "local.commandcode.label": "\u94FE\u63A5\u63D0\u4F9B\u65B9\u5305\uFF0C\u7136\u540E\u4F7F\u7528\u5382\u5546\u7AEF\u70B9",
  "local.commandcode.win32.label": "Windows \u4E0D\u652F\u6301",
  "freellmapi.default.0": "\u514B\u9686 FreeLLMAPI",
  "freellmapi.default.1": "\u751F\u6210 ENCRYPTION_KEY",
  "freellmapi.default.2": "\u542F\u52A8\u670D\u52A1\u6808",
  "freellmapi.default.3": "\u7B49\u5F85\u7F51\u5173\u5C31\u7EEA",
  "freellmapi.darwin.0": "\u4E0B\u8F7D\u6700\u65B0 .dmg",
  "freellmapi.darwin.1": "\u4ECE\u78C1\u76D8\u6620\u50CF\u5B89\u88C5\u5E94\u7528",
  "freellmapi.darwin.2": "\u5C06\u684C\u9762\u5E94\u7528\u56FA\u5B9A\u5230\u7AEF\u53E3 3002",
  "freellmapi.darwin.3": "\u542F\u52A8 FreeLLMAPI",
  "freellmapi.darwin.4": "\u7B49\u5F85\u7F51\u5173\u5C31\u7EEA",
  "freellmapi.win32.0": "\u4E0B\u8F7D\u6700\u65B0\u5B89\u88C5\u7A0B\u5E8F",
  "freellmapi.win32.1": "\u9759\u9ED8\u5B89\u88C5",
  "freellmapi.win32.2": "\u5C06\u684C\u9762\u5E94\u7528\u56FA\u5B9A\u5230\u7AEF\u53E3 3002",
  "freellmapi.win32.3": "\u542F\u52A8 FreeLLMAPI",
  "freellmapi.win32.4": "\u7B49\u5F85\u7F51\u5173\u5C31\u7EEA",
  "freellmapi.removal.0": "\u505C\u6B62\u670D\u52A1\u6808\u5E76\u5220\u9664\u5176\u6570\u636E\u5377",
  "freellmapi.removal.1": "\u5220\u9664\u5BB9\u5668\u955C\u50CF",
  "freellmapi.removal.2": "\u5220\u9664\u514B\u9686\u76EE\u5F55",
  "freellmapi.removal.3": "\u5220\u9664 macOS \u684C\u9762\u5E94\u7528\u53CA\u5176\u6570\u636E",
  "freellmapi.removal.4": "\u5220\u9664 Windows \u684C\u9762\u5E94\u7528\u53CA\u5176\u6570\u636E",
  "antigravity.default.0": "\u5B89\u88C5\u4EE3\u7406\u5305",
  "antigravity.default.1": "\u5199\u5165 systemd \u7528\u6237\u5355\u5143",
  "antigravity.default.2": "\u542F\u7528\u5E76\u542F\u52A8\u8BE5\u5355\u5143",
  "antigravity.default.3": "\u542F\u7528 lingering\uFF08\u65E0\u9700\u767B\u5F55\u4F1A\u8BDD\u5373\u53EF\u542F\u52A8\u8BE5\u5355\u5143\uFF09",
  "antigravity.default.4": "\u7B49\u5F85\u4EE3\u7406\u5C31\u7EEA",
  "antigravity.linux.0": "\u5B89\u88C5\u4EE3\u7406\u5305",
  "antigravity.linux.1": "\u5199\u5165 systemd \u7528\u6237\u5355\u5143",
  "antigravity.linux.2": "\u542F\u7528\u5E76\u542F\u52A8\u8BE5\u5355\u5143",
  "antigravity.linux.3": "\u542F\u7528 lingering\uFF08\u65E0\u9700\u767B\u5F55\u4F1A\u8BDD\u5373\u53EF\u542F\u52A8\u8BE5\u5355\u5143\uFF09",
  "antigravity.linux.4": "\u7B49\u5F85\u4EE3\u7406\u5C31\u7EEA",
  "antigravity.darwin.0": "\u5B89\u88C5\u4EE3\u7406\u5305",
  "antigravity.darwin.1": "\u5199\u5165 launchd \u4EE3\u7406",
  "antigravity.darwin.2": "\u52A0\u8F7D\u5E76\u542F\u52A8\u8BE5\u4EE3\u7406",
  "antigravity.darwin.3": "\u7B49\u5F85\u4EE3\u7406\u5C31\u7EEA",
  "antigravity.removal.0": "\u505C\u6B62\u5E76\u7981\u7528\u7528\u6237\u670D\u52A1",
  "antigravity.removal.1": "\u5220\u9664\u7528\u6237\u670D\u52A1\u6587\u4EF6",
  "antigravity.removal.2": "\u4ECE\u6BCF\u4E2A npm \u524D\u7F00\u5378\u8F7D\u8BE5\u5305",
  "antigravity.removal.3": "\u5220\u9664 macOS \u4EE3\u7406\u65E5\u5FD7",
  "antigravity.removal.4": "\u5220\u9664\u914D\u7F6E\u76EE\u5F55\uFF08accounts.json OAuth \u4EE4\u724C\u3001\u7528\u91CF\u5386\u53F2\u3001\u9884\u8BBE\uFF09",
  "antigravity.removal.5": "\u6E05\u7406 npm npx \u7F13\u5B58\u6B8B\u7559",
  "commandcode.default.0": "\u94FE\u63A5\u5E76\u6784\u5EFA DSH \u63D0\u4F9B\u65B9\u5305",
  "commandcode.linux.0": "\u94FE\u63A5\u5E76\u6784\u5EFA DSH \u63D0\u4F9B\u65B9\u5305",
  "commandcode.darwin.0": "\u94FE\u63A5\u5E76\u6784\u5EFA DSH \u63D0\u4F9B\u65B9\u5305",
  "summary.meridian": "\u901A\u8FC7\u5B98\u65B9 Agent SDK \u628A\u8FD0\u8425\u8005\u7684 Claude \u8BA2\u9605\u4F5C\u4E3A Anthropic Messages \u517C\u5BB9\u7AEF\u70B9\u63D0\u4F9B\u7684\u672C\u5730\u4EE3\u7406\u3002",
  "reuse.meridian.label": "\u4F7F\u7528\u68C0\u6D4B\u5230\u7684\u5B9E\u4F8B",
  "reuse.meridian.note": "\u96F6\u5B89\u88C5\uFF1A\u4F7F\u7528\u672C\u673A\u5DF2\u5728\u8FD0\u884C\u7684 Meridian \u4EE3\u7406\u53CA\u5176 Claude \u8BA2\u9605\u767B\u5F55\u3002",
  "local.meridian.label": "\u672C\u5730\u5B89\u88C5\uFF08npm + \u7528\u6237\u670D\u52A1\uFF09",
  "local.meridian.linux.label": "\u672C\u5730\u5B89\u88C5\uFF08npm + systemd \u7528\u6237\u5355\u5143\uFF09",
  "local.meridian.darwin.label": "\u672C\u5730\u5B89\u88C5\uFF08npm + launchd \u4EE3\u7406\uFF09",
  "local.meridian.win32.label": "Windows \u4E0D\u652F\u6301",
  "meridian.default.0": "\u68C0\u67E5 Node.js \u4E0E npm",
  "meridian.default.1": "\u7F3A\u5C11 Claude Code CLI \u6216\u7248\u672C\u4F4E\u4E8E 2.1.293 \u65F6\u5B89\u88C5",
  "meridian.default.2": "\u8981\u6C42\u5DF2\u767B\u5F55 Claude \u8BA2\u9605",
  "meridian.default.3": "\u5B89\u88C5 Meridian",
  "meridian.default.4": "\u5199\u5165 systemd \u7528\u6237\u5355\u5143",
  "meridian.default.5": "\u542F\u7528\u5E76\u542F\u52A8\u8BE5\u5355\u5143",
  "meridian.default.6": "\u7B49\u5F85 Meridian \u5C31\u7EEA",
  "meridian.linux.0": "\u68C0\u67E5 Node.js \u4E0E npm",
  "meridian.linux.1": "\u7F3A\u5C11 Claude Code CLI \u6216\u7248\u672C\u4F4E\u4E8E 2.1.293 \u65F6\u5B89\u88C5",
  "meridian.linux.2": "\u8981\u6C42\u5DF2\u767B\u5F55 Claude \u8BA2\u9605",
  "meridian.linux.3": "\u5B89\u88C5 Meridian",
  "meridian.linux.4": "\u5199\u5165 systemd \u7528\u6237\u5355\u5143",
  "meridian.linux.5": "\u542F\u7528\u5E76\u542F\u52A8\u8BE5\u5355\u5143",
  "meridian.linux.6": "\u7B49\u5F85 Meridian \u5C31\u7EEA",
  "meridian.darwin.0": "\u68C0\u67E5 Node.js \u4E0E npm",
  "meridian.darwin.1": "\u7F3A\u5C11 Claude Code CLI \u6216\u7248\u672C\u4F4E\u4E8E 2.1.293 \u65F6\u5B89\u88C5",
  "meridian.darwin.2": "\u8981\u6C42\u5DF2\u767B\u5F55 Claude \u8BA2\u9605",
  "meridian.darwin.3": "\u5B89\u88C5 Meridian",
  "meridian.darwin.4": "\u5199\u5165 launchd \u4EE3\u7406",
  "meridian.darwin.5": "\u52A0\u8F7D\u5E76\u542F\u52A8\u8BE5\u4EE3\u7406",
  "meridian.darwin.6": "\u7B49\u5F85 Meridian \u5C31\u7EEA",
  "meridian.removal.0": "\u505C\u6B62\u5E76\u7981\u7528\u7528\u6237\u670D\u52A1",
  "meridian.removal.1": "\u5220\u9664\u7528\u6237\u670D\u52A1\u6587\u4EF6",
  "meridian.removal.2": "\u5220\u9664 macOS \u4EE3\u7406\u65E5\u5FD7",
  "meridian.removal.3": "\u4FDD\u7559\u5168\u5C40 npm \u5305\uFF08\u4E0D\u5378\u8F7D @rynfar/meridian \u4E0E @anthropic-ai/claude-code\uFF09",
  "summary.cliproxyapi": "\u53EF\u9009\u7684\u591A\u8D26\u53F7\u8BA2\u9605\u7F51\u5173\uFF1A\u5728\u7BA1\u7406\u9762\u677F\u4E2D\u914D\u7F6E\u7684 CLI \u8D26\u53F7\u524D\u63D0\u4F9B\u4E00\u4E2A OpenAI \u517C\u5BB9\u7AEF\u70B9\u3002",
  "reuse.cliproxyapi.label": "\u4F7F\u7528\u68C0\u6D4B\u5230\u7684\u5B9E\u4F8B",
  "reuse.cliproxyapi.note": "\u96F6\u5B89\u88C5\uFF1A\u4F7F\u7528\u672C\u673A\u5DF2\u5728\u8FD0\u884C\u7684 CLIProxyAPI \u5B9E\u4F8B\u3002\u5BA2\u6237\u7AEF API \u5BC6\u94A5\u53EF\u9009\uFF0C\u9762\u677F\u4E0D\u4F1A\u81EA\u52A8\u767B\u5F55\u3002",
  "local.cliproxyapi.label": "\u672C\u5730\u5B89\u88C5\uFF08\u6821\u9A8C\u53D1\u5E03\u5305 + \u7528\u6237\u670D\u52A1\uFF09",
  "local.cliproxyapi.linux.label": "\u672C\u5730\u5B89\u88C5\uFF08\u6821\u9A8C\u53D1\u5E03\u5305 + systemd \u7528\u6237\u5355\u5143\uFF09",
  "local.cliproxyapi.darwin.label": "\u672C\u5730\u5B89\u88C5\uFF08\u6821\u9A8C\u53D1\u5E03\u5305 + launchd \u4EE3\u7406\uFF09",
  "local.cliproxyapi.win32.label": "Windows \u4E0D\u652F\u6301",
  "cliproxyapi.default.0": "\u5B89\u88C5 CLIProxyAPI\uFF08\u6821\u9A8C\u53D1\u5E03\u5305\u5E76\u914D\u7F6E\u7528\u6237\u670D\u52A1\uFF09",
  "cliproxyapi.linux.0": "\u5B89\u88C5 CLIProxyAPI\uFF08\u6821\u9A8C\u53D1\u5E03\u5305\u5E76\u914D\u7F6E\u7528\u6237\u670D\u52A1\uFF09",
  "cliproxyapi.darwin.0": "\u5B89\u88C5 CLIProxyAPI\uFF08\u6821\u9A8C\u53D1\u5E03\u5305\u5E76\u914D\u7F6E\u7528\u6237\u670D\u52A1\uFF09",
  "cliproxyapi.removal.0": "\u79FB\u9664 CLIProxyAPI \u5B89\u88C5\uFF08\u505C\u6B62\u670D\u52A1\u5E76\u5220\u9664\u53D7\u56DE\u6267\u4FDD\u62A4\u7684\u6587\u4EF6\uFF09"
};
var en = {
  "summary.freellmapi": "Self-hosted free-tier gateway: ~30 providers behind one OpenAI-compatible endpoint.",
  "summary.antigravity": "Multi-account Anthropic-compatible proxy for Google Antigravity OAuth accounts.",
  "summary.commandcode": "Command Code's CLI-shaped API at api.commandcode.ai, served by the DSH provider package and its native multi-key pool \u2014 no proxy.",
  "detected.label": "Use the detected instance",
  "reuse.freellmapi.label": "Use a detected instance",
  "reuse.freellmapi.note": "Zero install: uses a FreeLLMAPI instance already running on this device.",
  "reuse.antigravity.label": "Use a detected instance",
  "reuse.antigravity.note": "Zero install: uses the proxy instance already running on this device and its configured account pool.",
  "reuse.commandcode.label": "Use the vendor endpoint now",
  "reuse.commandcode.note": "Writes the route at the vendor endpoint after confirming it answers; run the local setup first when the provider package is not linked yet.",
  "local.freellmapi.label": "Install locally (Docker or Podman)",
  "local.freellmapi.darwin.label": "Install locally (vendor desktop app, no Docker)",
  "local.freellmapi.win32.label": "Install locally (vendor desktop app, no Docker)",
  "local.antigravity.label": "Install locally (npm + user service)",
  "local.antigravity.linux.label": "Install locally (npm + systemd user unit)",
  "local.antigravity.darwin.label": "Install locally (npm + launchd agent)",
  "local.antigravity.win32.label": "Not supported on Windows",
  "local.commandcode.label": "Link the provider package, then use the vendor endpoint",
  "local.commandcode.win32.label": "Not supported on Windows",
  "freellmapi.default.0": "Clone FreeLLMAPI",
  "freellmapi.default.1": "Generate ENCRYPTION_KEY",
  "freellmapi.default.2": "Start the stack",
  "freellmapi.default.3": "Wait for the gateway",
  "freellmapi.darwin.0": "Download the latest .dmg",
  "freellmapi.darwin.1": "Install the app from the disk image",
  "freellmapi.darwin.2": "Pin the desktop app to port 3002",
  "freellmapi.darwin.3": "Launch FreeLLMAPI",
  "freellmapi.darwin.4": "Wait for the gateway",
  "freellmapi.win32.0": "Download the latest installer",
  "freellmapi.win32.1": "Install silently",
  "freellmapi.win32.2": "Pin the desktop app to port 3002",
  "freellmapi.win32.3": "Launch FreeLLMAPI",
  "freellmapi.win32.4": "Wait for the gateway",
  "freellmapi.removal.0": "Stop the stack and drop its volume",
  "freellmapi.removal.1": "Remove the container image",
  "freellmapi.removal.2": "Remove the clone directory",
  "freellmapi.removal.3": "Remove the macOS desktop app and its data",
  "freellmapi.removal.4": "Remove the Windows desktop app and its data",
  "antigravity.default.0": "Install the proxy package",
  "antigravity.default.1": "Write the systemd user unit",
  "antigravity.default.2": "Enable and start the unit",
  "antigravity.default.3": "Enable lingering (the unit starts without an open login session)",
  "antigravity.default.4": "Wait for the proxy",
  "antigravity.linux.0": "Install the proxy package",
  "antigravity.linux.1": "Write the systemd user unit",
  "antigravity.linux.2": "Enable and start the unit",
  "antigravity.linux.3": "Enable lingering (the unit starts without an open login session)",
  "antigravity.linux.4": "Wait for the proxy",
  "antigravity.darwin.0": "Install the proxy package",
  "antigravity.darwin.1": "Write the launchd agent",
  "antigravity.darwin.2": "Load and start the agent",
  "antigravity.darwin.3": "Wait for the proxy",
  "antigravity.removal.0": "Stop and disable the user service",
  "antigravity.removal.1": "Remove the user service file",
  "antigravity.removal.2": "Uninstall the package from every npm prefix",
  "antigravity.removal.3": "Remove the macOS agent logs",
  "antigravity.removal.4": "Remove the config directory (accounts.json OAuth tokens, usage history, presets)",
  "antigravity.removal.5": "Remove npm npx cache residue",
  "commandcode.default.0": "Link and build the DSH provider package",
  "commandcode.linux.0": "Link and build the DSH provider package",
  "commandcode.darwin.0": "Link and build the DSH provider package",
  "summary.meridian": "Local proxy that serves the operator's Claude subscription through the official Agent SDK as an Anthropic Messages-compatible endpoint.",
  "reuse.meridian.label": "Use a detected instance",
  "reuse.meridian.note": "Zero install: uses a Meridian proxy already running on this device and its Claude subscription login.",
  "local.meridian.label": "Install locally (npm + user service)",
  "local.meridian.linux.label": "Install locally (npm + systemd user unit)",
  "local.meridian.darwin.label": "Install locally (npm + launchd agent)",
  "local.meridian.win32.label": "Not supported on Windows",
  "meridian.default.0": "Check Node.js and npm",
  "meridian.default.1": "Install the Claude Code CLI when it is missing or older than 2.1.293",
  "meridian.default.2": "Require a Claude subscription login",
  "meridian.default.3": "Install Meridian",
  "meridian.default.4": "Write the systemd user unit",
  "meridian.default.5": "Enable and start the unit",
  "meridian.default.6": "Wait for Meridian",
  "meridian.linux.0": "Check Node.js and npm",
  "meridian.linux.1": "Install the Claude Code CLI when it is missing or older than 2.1.293",
  "meridian.linux.2": "Require a Claude subscription login",
  "meridian.linux.3": "Install Meridian",
  "meridian.linux.4": "Write the systemd user unit",
  "meridian.linux.5": "Enable and start the unit",
  "meridian.linux.6": "Wait for Meridian",
  "meridian.darwin.0": "Check Node.js and npm",
  "meridian.darwin.1": "Install the Claude Code CLI when it is missing or older than 2.1.293",
  "meridian.darwin.2": "Require a Claude subscription login",
  "meridian.darwin.3": "Install Meridian",
  "meridian.darwin.4": "Write the launchd agent",
  "meridian.darwin.5": "Load and start the agent",
  "meridian.darwin.6": "Wait for Meridian",
  "meridian.removal.0": "Stop and disable the user service",
  "meridian.removal.1": "Remove the user service file",
  "meridian.removal.2": "Remove the macOS agent logs",
  "meridian.removal.3": "Leave the global npm packages installed (@rynfar/meridian and @anthropic-ai/claude-code are not uninstalled)",
  "summary.cliproxyapi": "Optional multi-account subscription gateway: one OpenAI-compatible endpoint in front of the CLI accounts you configure in its dashboard.",
  "reuse.cliproxyapi.label": "Use a detected instance",
  "reuse.cliproxyapi.note": "Zero install: uses a CLIProxyAPI instance already running on this device. The client API key is optional and the dashboard is not signed in automatically.",
  "local.cliproxyapi.label": "Install locally (verified release + user service)",
  "local.cliproxyapi.linux.label": "Install locally (verified release + systemd user unit)",
  "local.cliproxyapi.darwin.label": "Install locally (verified release + launchd agent)",
  "local.cliproxyapi.win32.label": "Not supported on Windows",
  "cliproxyapi.default.0": "Install CLIProxyAPI (verified release and user service)",
  "cliproxyapi.linux.0": "Install CLIProxyAPI (verified release and user service)",
  "cliproxyapi.darwin.0": "Install CLIProxyAPI (verified release and user service)",
  "cliproxyapi.removal.0": "Remove the CLIProxyAPI install (stop the service and remove verified files)"
};
function text(locale, key, fallback) {
  const value = (locale === "zh" ? zh : en)[key];
  return value ?? fallback;
}
function localizeSteps(locale, manifestId, variant, steps) {
  return steps.map((step, index) => ({
    ...step,
    label: text(locale, `${manifestId}.${variant}.${index}`, step.label)
  }));
}
function localizeVariant(locale, manifestId, variant, install) {
  return {
    ...install,
    ...install.label === void 0 ? {} : { label: text(locale, `local.${manifestId}.${variant}.label`, install.label) },
    steps: localizeSteps(locale, manifestId, variant, install.steps)
  };
}
function localizeHeavyManifest(manifest, locale) {
  if (locale === "en") return manifest;
  return {
    ...manifest,
    summary: text(locale, `summary.${manifest.id}`, manifest.summary),
    reuse: {
      ...manifest.reuse,
      label: text(locale, `reuse.${manifest.id}.label`, manifest.reuse.label),
      note: text(locale, `reuse.${manifest.id}.note`, manifest.reuse.note)
    },
    local: {
      ...manifest.local,
      label: text(locale, `local.${manifest.id}.label`, manifest.local.label),
      install: {
        default: localizeVariant(locale, manifest.id, "default", manifest.local.install.default),
        ...manifest.local.install.linux === void 0 ? {} : { linux: localizeVariant(locale, manifest.id, "linux", manifest.local.install.linux) },
        ...manifest.local.install.darwin === void 0 ? {} : { darwin: localizeVariant(locale, manifest.id, "darwin", manifest.local.install.darwin) },
        ...manifest.local.install.win32 === void 0 ? {} : { win32: localizeVariant(locale, manifest.id, "win32", manifest.local.install.win32) }
      }
    },
    removal: {
      ...manifest.removal,
      steps: localizeSteps(locale, manifest.id, "removal", manifest.removal.steps)
    }
  };
}
function localizeHeavySteps(manifest, platform, steps, locale) {
  if (locale === "en") return steps;
  const declared = platform === "linux" || platform === "darwin" || platform === "win32" ? manifest.local.install[platform] : void 0;
  return localizeSteps(locale, manifest.id, declared === void 0 ? "default" : platform, steps);
}
function localizeHeavyPreflight(preflight, manifest, platform, locale) {
  if (locale === "en") return preflight;
  if (preflight.path === "detected") {
    return { ...preflight, label: text(locale, "detected.label", preflight.label) };
  }
  const resolved = resolveHeavyInstall(manifest.local, platform);
  return { ...preflight, label: resolved.label, steps: resolved.steps };
}

// src/remote.ts
var MAX_KEY_CHARS = 4096;
var RUNTIME_TTL_MS = 6e4;
function requireManifest(value) {
  if (typeof value !== "string" || value === "") {
    throw new RemoteError("gateway/bad-request", "enpoiHeavy: id must be a non-empty string", {});
  }
  const manifest = manifestById(value);
  if (manifest === void 0) {
    throw new RemoteError("gateway/bad-request", `enpoiHeavy: unknown heavy provider "${value}"`, {});
  }
  return manifest;
}
function optionalKey(value) {
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "string") throw new RemoteError("gateway/bad-request", "enpoiHeavy: key must be a string", {});
  if (value.length > MAX_KEY_CHARS) throw new RemoteError("gateway/bad-request", "enpoiHeavy: key is too long", {});
  return value;
}
var MAX_BASE_URL_CHARS = 2048;
function optionalBaseURL(value) {
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "string") throw new RemoteError("gateway/bad-request", "enpoiHeavy: baseURL must be a string", {});
  if (value.trim() === "") return void 0;
  if (value.length > MAX_BASE_URL_CHARS) throw new RemoteError("gateway/bad-request", "enpoiHeavy: baseURL is too long", {});
  const normalized = instanceBaseURLFromInput(value);
  if (normalized === void 0) {
    throw new RemoteError("gateway/bad-request", "enpoiHeavy: baseURL must be an absolute http(s) URL", {});
  }
  return normalized;
}
function duplicateRouteBlock(manifest) {
  return {
    ok: false,
    blocked: {
      reason: `provider "${manifest.id}" already has a configured route; remove it before adding it again`,
      plannedWith: "remove the existing route first (Add never overwrites a configured profile)"
    }
  };
}
function stepNeedsProfileDir(step) {
  return step.command.includes("{profileDir}") || step.command.includes("$DSH_HEAVY_PROFILE_DIR") || step.cwd?.includes("{profileDir}") === true;
}
function missingProfileDirBlock() {
  return {
    ok: false,
    blocked: {
      reason: 'The running profile root is unknown, so the local install command containing "{profileDir}" cannot be expanded. Start this profile through the dsh launcher (which supplies profileContext.dir), or set the enpoi-heavy-providers profileDir config explicitly, then retry.',
      plannedWith: 'No install step was started; the command containing "{profileDir}" was never executed.'
    }
  };
}
var _remove_dec, _job_dec, _install_dec, _reuse_dec, _status_dec, _manifests_dec, _a, _init;
var HeavyProvidersService = class extends (_a = TypertRemoteService, _manifests_dec = [Remote], _status_dec = [Remote], _reuse_dec = [Remote], _install_dec = [Remote], _job_dec = [Remote], _remove_dec = [Remote], _a) {
  /**
   * @param ctx - owning context (service registration is automatic).
   * @param options - deps accessor, job manager, and optional log sink.
   */
  constructor(ctx, options) {
    super(ctx, "enpoiHeavy");
    __runInitializers(_init, 5, this);
    __publicField(this, "options");
    __publicField(this, "runtimeCache");
    this.options = options;
  }
  /** The machine's container runtimes, memoized for one minute. */
  async runtime() {
    const now = Date.now();
    if (this.runtimeCache !== void 0 && now - this.runtimeCache.at < RUNTIME_TTL_MS) {
      return this.runtimeCache.value;
    }
    const value = await detectRuntimes(this.options.deps().runStep);
    this.runtimeCache = { at: now, value };
    return value;
  }
  /** The operator-visible locale: the durable preference, else the host environment. */
  locale() {
    return settingsLocale(this.options.deps().settings);
  }
  /**
   * Resolve one wire id to its effective manifest, refusing a provider the
   * operator disabled. `remove`/`job` keep the plain resolution: an operator
   * who disables a provider must still be able to clean up its state.
   */
  requireEnabledManifest(value) {
    const manifest = requireManifest(value);
    const entry = readServerOverlay(this.options.deps().dshHome)[manifest.id];
    if (entry?.disabled === true) {
      throw new RemoteError(
        "gateway/bad-request",
        `enpoiHeavy: provider "${manifest.id}" is disabled by $DSH_HOME/heavy-server-overlay.json`,
        {}
      );
    }
    return overlayManifest(manifest, entry);
  }
  manifests() {
    const overlay = readServerOverlay(this.options.deps().dshHome);
    const locale = this.locale();
    return {
      items: effectiveHeavyManifests(HEAVY_MANIFESTS, overlay).map((manifest) => localizeHeavyManifest(manifest, locale)),
      problems: manifestProblems(),
      platform: process.platform
    };
  }
  /**
   * Secretless installer paths for the status hint. Only a verified owned
   * local install asks the host reader; the reader never returns a key.
   */
  async installPaths(id) {
    try {
      return await this.options.deps().readInstallPaths?.(id) ?? {};
    } catch {
      return {};
    }
  }
  async status(request) {
    const manifest = this.requireEnabledManifest(request?.id);
    const deps = this.options.deps();
    const locale = this.locale();
    const settingsNs = routeSettingsNs(manifest);
    const profile = configuredProfile(deps, manifest.id, settingsNs);
    const configured = profile !== void 0;
    const configuredBase = typeof profile?.baseURL === "string" ? profile.baseURL : void 0;
    const lifecycle = lifecycleOf(deps.dshHome, manifest.id);
    const ownedLocal = ownsLocalInstall(lifecycle);
    const mode = configured ? lifecycle?.mode ?? "unknown" : ownedLocal ? "local" : void 0;
    const direct = manifest.delivery === "direct";
    const detection = direct ? void 0 : await detectInstance(deps, manifest, configuredBase);
    const runtime = await this.runtime();
    const preflight = chooseLocalPath(
      manifest,
      process.platform,
      runtime,
      detection?.ok === true ? detection.port : void 0,
      {
        home: deps.home,
        dshHome: deps.dshHome,
        ...deps.profileDir === void 0 ? {} : { profileDir: deps.profileDir },
        ...deps.installHelperPath === void 0 ? {} : { helperPath: deps.installHelperPath }
      }
    );
    const localizedManifest = localizeHeavyManifest(manifest, locale);
    const localizedPreflight = localizeHeavyPreflight(preflight, localizedManifest, process.platform, locale);
    const configuredHealthUrl = configuredBase === void 0 ? void 0 : healthForBase(manifest, configuredBase).url;
    const health = direct ? await probeHealth(manifest.reuse.health, deps.fetchImpl) : configuredBase !== void 0 ? detection !== void 0 && detection.url === configuredHealthUrl ? detection.health : await probeHealth(healthForBase(manifest, configuredBase), deps.fetchImpl) : detection.health;
    const isReachable = reachable(health);
    const settingsReady = settingsNamespaceReady(deps, settingsNs);
    const job = visibleJobSnapshot(this.options.jobs.snapshot(manifest.id), configured);
    return {
      id: manifest.id,
      manifest: localizedManifest,
      settingsNs,
      ...settingsReady === void 0 ? {} : { settingsReady },
      configured,
      ...mode === void 0 ? {} : { mode },
      ...lifecycle === void 0 ? {} : {
        installedByHarness: lifecycle.installedByHarness,
        ...lifecycle.setupKind === void 0 ? {} : { setupKind: lifecycle.setupKind },
        ...lifecycle.endpoint === void 0 && configuredBase === void 0 ? {} : { endpoint: lifecycle.endpoint ?? configuredBase }
      },
      ...ownedLocal ? await this.installPaths(manifest.id) : {},
      health: { ...health, reachable: isReachable },
      platform: process.platform,
      runtime,
      preflight: localizedPreflight,
      ...detection?.ok === true && detection.port !== void 0 ? { detectedPort: detection.port } : {},
      ...detection?.ok === true ? { detectedEndpoint: detection.baseURL } : {},
      ...manifest.unsupported === void 0 ? {} : { unsupported: manifest.unsupported },
      ...job === void 0 ? {} : { job }
    };
  }
  async reuse(request) {
    const manifest = this.requireEnabledManifest(request?.id);
    const key = optionalKey(request?.key);
    const baseURL = optionalBaseURL(request?.baseURL);
    if (baseURL !== void 0 && manifest.delivery === "direct") {
      throw new RemoteError(
        "gateway/bad-request",
        `enpoiHeavy: "${manifest.id}" is a direct vendor route; a custom instance URL does not apply`,
        {}
      );
    }
    const deps = this.options.deps();
    if (configuredProfile(deps, manifest.id, routeSettingsNs(manifest)) !== void 0) {
      this.options.log?.(`reuse ${manifest.id}: refused, route already configured`);
      return duplicateRouteBlock(manifest);
    }
    if (manifest.unsupported !== void 0) {
      return { ok: false, blocked: { reason: manifest.unsupported.reason, plannedWith: manifest.unsupported.plannedWith } };
    }
    const pendingRestart = pendingRestartForManifest(deps, manifest);
    if (pendingRestart !== void 0) {
      this.options.log?.(`reuse ${manifest.id}: waiting for restart (${pendingRestart.ns} is not mounted)`);
      return { ok: false, pendingRestart };
    }
    const outcome = await useDetectedInstance(deps, manifest, key, baseURL === void 0 ? {} : { baseURL });
    this.options.log?.(`detected ${manifest.id}: health=${outcome.health.ok ? "ok" : "down"} endpoint=${outcome.endpoint} models=${String(outcome.models.length)}`);
    return { ok: true, ...outcome };
  }
  async install(request) {
    if (request !== null && typeof request === "object" && Object.hasOwn(request, "receipt")) {
      throw new RemoteError(
        "gateway/bad-request",
        "enpoiHeavy: install does not accept a client ownership receipt",
        {}
      );
    }
    const manifest = this.requireEnabledManifest(request?.id);
    const submittedKey = optionalKey(request?.key);
    const selfKeyingInstaller = manifest.id === "cliproxyapi";
    const key = selfKeyingInstaller ? void 0 : submittedKey;
    if (selfKeyingInstaller && submittedKey !== void 0 && submittedKey !== "") {
      this.options.log?.(`install ${manifest.id}: ignoring the client-supplied key; the installer generates its own`);
    }
    const deps = this.options.deps();
    if (configuredProfile(deps, manifest.id, routeSettingsNs(manifest)) !== void 0) {
      this.options.log?.(`install ${manifest.id}: refused, route already configured`);
      return duplicateRouteBlock(manifest);
    }
    if (manifest.unsupported !== void 0) {
      return { ok: false, blocked: { reason: manifest.unsupported.reason, plannedWith: manifest.unsupported.plannedWith } };
    }
    const platformBlocked = platformUnsupported(manifest, process.platform);
    if (platformBlocked !== void 0) {
      this.options.log?.(`install ${manifest.id}: refused on ${process.platform} (${platformBlocked})`);
      return { ok: false, blocked: { reason: platformBlocked, plannedWith: 'run the service manually and add it with "Use a detected instance"' } };
    }
    const localSteps = resolveHeavyInstall(manifest.local, process.platform).steps;
    if (deps.profileDir === void 0 && localSteps.some(stepNeedsProfileDir)) {
      this.options.log?.(`install ${manifest.id}: refused, running profile root is unknown`);
      return missingProfileDirBlock();
    }
    const runtime = await this.runtime();
    const preflight = chooseLocalPath(manifest, process.platform, runtime, void 0, {
      home: deps.home,
      dshHome: deps.dshHome,
      ...deps.profileDir === void 0 ? {} : { profileDir: deps.profileDir },
      ...deps.installHelperPath === void 0 ? {} : { helperPath: deps.installHelperPath }
    });
    if (preflight.path === "unsupported") {
      const reason = preflight.missing.length > 0 ? preflight.missing.join("; ") : preflight.label;
      this.options.log?.(`install ${manifest.id}: runtime preflight refused (${reason})`);
      return { ok: false, blocked: { reason, plannedWith: preflight.label } };
    }
    let helperRefusal;
    try {
      const helperPreflight = await deps.installPreflight?.(manifest.id);
      if (helperPreflight !== void 0 && helperPreflight.ok === false) helperRefusal = helperPreflight.reason ?? "the installer port preflight refused the install";
    } catch (error) {
      helperRefusal = `the installer port preflight failed (${error instanceof Error ? error.message : String(error)})`;
    }
    if (helperRefusal !== void 0) {
      this.options.log?.(`install ${manifest.id}: helper preflight refused (${helperRefusal})`);
      return { ok: false, blocked: { reason: helperRefusal, plannedWith: "No install job was started and no port was claimed." } };
    }
    const pendingRestart = pendingRestartForManifest(deps, manifest);
    if (pendingRestart !== void 0) {
      this.options.log?.(`install ${manifest.id}: waiting for restart (${pendingRestart.ns} is not mounted)`);
      return { ok: false, pendingRestart };
    }
    const steps = localizeHeavySteps(
      manifest,
      process.platform,
      withReleaseSource(localSteps, manifest.releaseSource),
      this.locale()
    );
    const job = this.options.jobs.start(manifest.id, "install", steps, async () => {
      const current = this.options.deps();
      const late = pendingRestartForManifest(current, manifest);
      if (late !== void 0) throw new Error(late.message);
      if (configuredProfile(current, manifest.id, routeSettingsNs(manifest)) !== void 0) {
        throw new Error(
          `provider "${manifest.id}" received a route while the install was running; the install refused to overwrite it (remove the existing route first)`
        );
      }
      const localBaseURL = modeBaseURL(manifest, "local");
      let receipt = await current.readInstallReceipt?.(manifest.id);
      const requiresOwnedInstaller = manifest.id === "cliproxyapi";
      if (receipt === void 0 && !requiresOwnedInstaller) {
        receipt = await current.issueInstallReceipt?.(manifest.id);
      }
      if (requiresOwnedInstaller && receipt === void 0) {
        throw new Error(
          "CLIProxyAPI install finished without a verified ownership receipt. The service may still be installed; no route was written and existing credentials were not changed. Repair the receipt, binary/unit hashes, and bootstrap owner token, then retry the install or add the detected instance."
        );
      }
      if (receipt !== void 0) {
        registerInstallOwnership(current.dshHome, manifest.id, receipt, {
          setupKind: "harness-install",
          endpoint: localBaseURL
        });
      }
      const installedCredential = manifest.auth.kind === "unified" ? (await current.readInstallCredential?.(manifest.id))?.trim() : void 0;
      const seededKey = installedCredential === void 0 || installedCredential === "" ? void 0 : installedCredential;
      if (requiresOwnedInstaller && seededKey === void 0) {
        throw new Error(
          "CLIProxyAPI is installed but its generated inference key is unreadable. No route was written and existing credentials were not overwritten. Repair config.yaml access.api-keys or bootstrap.json, then retry the install or add the detected instance."
        );
      }
      let seededStored = false;
      if (seededKey !== void 0) {
        try {
          seededStored = await storeCredential(current, manifest, seededKey);
        } catch (error) {
          if (!requiresOwnedInstaller) throw error;
          const cause = error instanceof Error ? error.message : String(error);
          throw new Error(
            `CLIProxyAPI is installed but its generated inference key could not be stored (${cause}). No route was written and existing credentials were not intentionally changed; repair the credentials service and retry the install or add the detected instance.`
          );
        }
      }
      if (requiresOwnedInstaller && !seededStored) {
        throw new Error(
          "CLIProxyAPI is installed but its generated inference key could not be stored. No route was written; repair the credentials service and retry the install or add the detected instance."
        );
      }
      const effectiveKey = requiresOwnedInstaller ? seededKey : await resolveRouteKey(current, manifest, seededStored ? seededKey : key);
      const catalog = await discoverServiceCatalog(current, manifest, localBaseURL, effectiveKey, {
        resolveStoredCredential: false
      });
      if (catalogAuthorityOf(manifest) === "endpoint" && (catalog.state === "failed" || catalog.state === "unauthorized")) {
        throw new Error(
          `${manifest.label} is installed but its model listing was ${catalog.state}${catalog.error === void 0 ? "" : ` (${catalog.error})`}; no route was written. Check the service and its client key, then retry the install or add the detected instance.`
        );
      }
      if (catalog.state === "empty") writeKnownEmptyDiscoveredEntry(current, manifest.id, localBaseURL);
      const routeKey = seededStored ? void 0 : key;
      const keyless = manifest.auth.kind === "unified" && effectiveKey !== void 0 ? false : void 0;
      try {
        await commitRoute(current, manifest, "local", catalog.models, routeKey, {
          catalogState: catalog.state,
          refuseExisting: true,
          ...keyless === void 0 ? {} : { keyless }
        });
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        if (receipt !== void 0 || seededKey !== void 0) {
          throw new Error(`${cause} \u2014 ${manifest.label} is installed; retry the install or add the detected instance`);
        }
        throw error;
      }
    });
    return { ok: true, job };
  }
  job(request) {
    const manifest = requireManifest(request?.id);
    const job = this.options.jobs.snapshot(manifest.id);
    return job === void 0 ? {} : { job };
  }
  async remove(request) {
    const manifest = requireManifest(request?.id);
    if (request?.uninstall !== void 0 && typeof request.uninstall !== "boolean") {
      throw new RemoteError("gateway/bad-request", "enpoiHeavy: uninstall must be a boolean", {});
    }
    const deps = this.options.deps();
    const effective = overlayManifest(manifest, readServerOverlay(deps.dshHome)[manifest.id]);
    const lockedDeps = deps.jobs === void 0 ? { ...deps, jobs: this.options.jobs } : deps;
    const summary = await removeProvider(lockedDeps, effective, { uninstall: request?.uninstall === true });
    this.options.log?.(`remove ${manifest.id}: route=${String(summary.routeRemoved)} pool=${String(summary.poolStateRemoved)} cache=${String(summary.cacheEntryRemoved)} teardown=${String(summary.teardown.ok)}`);
    return { ok: summary.errors.length === 0, summary };
  }
};
_init = __decoratorStart(_a);
__decorateElement(_init, 1, "manifests", _manifests_dec, HeavyProvidersService);
__decorateElement(_init, 1, "status", _status_dec, HeavyProvidersService);
__decorateElement(_init, 1, "reuse", _reuse_dec, HeavyProvidersService);
__decorateElement(_init, 1, "install", _install_dec, HeavyProvidersService);
__decorateElement(_init, 1, "job", _job_dec, HeavyProvidersService);
__decorateElement(_init, 1, "remove", _remove_dec, HeavyProvidersService);
__decoratorMetadata(_init, HeavyProvidersService);
/** Nothing is injected into the service fiber; the plugin passes its deps. */
__publicField(HeavyProvidersService, "inject", []);

// src/index.ts
var INSTALL_HELPER_PATH = fileURLToPath(new URL("../scripts/cliproxyapi-install.mjs", import.meta.url));
var cliProxyHelpers = /* @__PURE__ */ new Map();
var name = "enpoi-heavy-providers";
var inject = [];
var CLIPROXYAPI_ID = "cliproxyapi";
var Config = Schema.object({
  profileDir: Schema.string()
});
function profileDirectory(ctx, config) {
  const profile = ctx.get("profileContext");
  if (typeof profile?.dir === "string" && profile.dir.trim() !== "") return profile.dir;
  const configured = config.profileDir?.trim();
  if (configured === void 0 || configured === "") return void 0;
  if (!isAbsolute(configured)) {
    throw new Error(
      `enpoi-heavy-providers: config.profileDir must be an absolute path (got ${JSON.stringify(configured)}); a relative value cannot be resolved consistently for the running profile.`
    );
  }
  return configured;
}
function needsProfileDir(step) {
  return step.command.includes("{profileDir}") || step.command.includes("$DSH_HEAVY_PROFILE_DIR") || step.cwd?.includes("{profileDir}") === true;
}
async function loadCliProxyHelper() {
  const script = INSTALL_HELPER_PATH;
  const info = statSync(script);
  const stamp = `${String(info.mtimeMs)}:${String(info.size)}:${String(info.ino)}`;
  const cached = cliProxyHelpers.get(script);
  if (cached !== void 0 && cached.stamp === stamp) return await cached.promise;
  const pending = import(`${pathToFileURL(script).href}?stamp=${encodeURIComponent(stamp)}`);
  cliProxyHelpers.set(script, { stamp, promise: pending });
  try {
    return await pending;
  } catch (error) {
    const current = cliProxyHelpers.get(script);
    if (current?.stamp === stamp) cliProxyHelpers.delete(script);
    throw error;
  }
}
function readOwnedRecord(path) {
  try {
    const value = JSON.parse(readFileSync5(path, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
  } catch {
    return void 0;
  }
}
function ownerTokenDigest(token) {
  return createHash2("sha256").update(token).digest("hex");
}
function installStatusRejectsOwnership(status) {
  return status.portMismatch === true || status.credentialsPresent === false;
}
async function cliproxyapiReceipt(dshHome) {
  try {
    const helper = await loadCliProxyHelper();
    const status = await helper.statusCliProxyApi({ dshHome });
    if (status.installed !== true || status.binaryMatches !== true || status.unitMatches !== true) return void 0;
    if (installStatusRejectsOwnership(status)) return void 0;
    if (status.installId === void 0 || status.installId === "") return void 0;
    const layout = helper.resolveCliProxyLayout({ dshHome });
    const receipt = readOwnedRecord(layout.receiptPath);
    const bootstrap = readOwnedRecord(layout.bootstrapPath);
    if (receipt === void 0 || bootstrap === void 0) return void 0;
    if (receipt.version !== helper.RECEIPT_VERSION || bootstrap.version !== helper.RECEIPT_VERSION) return void 0;
    if (receipt.installId !== status.installId || bootstrap.installId !== receipt.installId) return void 0;
    const expectedPaths = {
      root: layout.root,
      binaryPath: layout.binaryPath,
      configPath: layout.configPath,
      authDir: layout.authDir,
      bootstrapPath: layout.bootstrapPath,
      unitPath: layout.unitPath,
      serviceLabel: layout.serviceLabel,
      serviceKind: layout.serviceKind
    };
    for (const [field, expected] of Object.entries(expectedPaths)) {
      if (receipt[field] !== expected) return void 0;
    }
    const ownerToken = bootstrap.ownerToken;
    const ownerTokenSha256 = receipt.ownerTokenSha256;
    if (typeof ownerToken !== "string" || !/^[a-f0-9]{64}$/u.test(ownerToken)) return void 0;
    if (typeof ownerTokenSha256 !== "string" || ownerTokenDigest(ownerToken) !== ownerTokenSha256) return void 0;
    return status.installId;
  } catch {
    return void 0;
  }
}
function providerReceiptDir(dshHome, id) {
  return join5(dshHome, "providers", id);
}
function providerReceiptPath(dshHome, id) {
  return join5(providerReceiptDir(dshHome, id), "receipt.json");
}
async function providerInstallReceipt(dshHome, id) {
  if (id === CLIPROXYAPI_ID) return cliproxyapiReceipt(dshHome);
  try {
    const file = providerReceiptPath(dshHome, id);
    if (!existsSync2(file)) return void 0;
    const raw = JSON.parse(readFileSync5(file, "utf8"));
    if (raw && raw.version === 1 && raw.id === id && typeof raw.receipt === "string" && raw.receipt.length > 0) {
      return raw.receipt;
    }
  } catch {
    return void 0;
  }
  return void 0;
}
async function issueHostInstallReceipt(dshHome, id) {
  if (id === CLIPROXYAPI_ID) return cliproxyapiReceipt(dshHome);
  try {
    const dir = providerReceiptDir(dshHome, id);
    mkdirSync5(dir, { recursive: true });
    const file = providerReceiptPath(dshHome, id);
    const installId = randomUUID3();
    const receipt = `dsh-owned:${id}:${installId}`;
    const record = {
      version: 1,
      id,
      installId,
      installedAt: Date.now(),
      platform: process.platform,
      receipt
    };
    const tmp = `${file}.tmp-${String(process.pid)}-${randomUUID3()}`;
    writeFileSync5(tmp, JSON.stringify(record, null, 2), { encoding: "utf8", mode: 384 });
    renameSync4(tmp, file);
    return receipt;
  } catch {
    return void 0;
  }
}
async function clearHostInstallReceipt(dshHome, id) {
  if (id !== CLIPROXYAPI_ID) {
    try {
      rmSync4(providerReceiptPath(dshHome, id), { force: true });
    } catch {
    }
  }
}
async function cliproxyapiCredential(dshHome) {
  try {
    const helper = await loadCliProxyHelper();
    return await helper.readOwnedInferenceCredential(dshHome);
  } catch {
    return void 0;
  }
}
async function cliproxyapiInstallPaths(dshHome) {
  try {
    const helper = await loadCliProxyHelper();
    const layout = helper.resolveCliProxyLayout({ dshHome });
    return { bootstrapPath: layout.bootstrapPath, managementKeyPath: layout.bootstrapPath };
  } catch {
    return void 0;
  }
}
async function cliproxyapiInstallPreflight(dshHome) {
  try {
    const helper = await loadCliProxyHelper();
    const candidate = helper.preflightCliProxyApi;
    if (typeof candidate !== "function") return void 0;
    const result = await candidate({ dshHome });
    if (result === null || typeof result !== "object") return { ok: true };
    const record = result;
    if (record.ok !== false) return { ok: true };
    const reason = typeof record.reason === "string" && record.reason !== "" ? record.reason : typeof record.error?.message === "string" && record.error.message !== "" ? record.error.message : "the CLIProxyAPI installer port preflight refused the install";
    return { ok: false, reason };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
async function runStep(ctx, step, home, dshHome, profileDir) {
  if (profileDir === void 0 && needsProfileDir(step)) {
    throw new Error(
      `Cannot run heavy-provider step "${step.label}": the running profile root is unknown. Start this profile through the dsh launcher so it supplies profileContext.dir, or set the enpoi-heavy-providers profileDir config explicitly; the command containing "{profileDir}" was not executed.`
    );
  }
  const subprocess = ctx.get("subprocess");
  if (subprocess === void 0) throw new Error("subprocess seam absent \u2014 cannot run install steps");
  const targetCwd = step.cwd === void 0 ? home : substitute(step.cwd, home, dshHome, profileDir);
  const actualCwd = existsSync2(targetCwd) ? targetCwd : home;
  try {
    const handle = subprocess.spawn({
      argv: ["/bin/bash", "-lc", substitute(step.command, home, dshHome, profileDir)],
      cwd: actualCwd,
      // Host paths travel in the environment, never in the command text:
      // quoting a path is not enough when it can contain `$`, a backtick, or
      // a quote. Steps reference these as "$DSH_HEAVY_*".
      env: {
        [HEAVY_ENV.home]: home,
        [HEAVY_ENV.dshHome]: dshHome,
        [HEAVY_ENV.profileDir]: profileDir ?? "",
        [HEAVY_ENV.helper]: INSTALL_HELPER_PATH
      },
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: 65536 },
        stderr: { maxBytes: 65536 }
      },
      graceMs: 1e4
    });
    const outcome = await handle.done;
    const stdout = handle.collected.stdout?.readFrom(0).text ?? "";
    const stderr = handle.collected.stderr?.readFrom(0).text ?? "";
    return { exitCode: outcome.exitCode, output: `${stdout}${stderr}`.slice(-16384) };
  } catch (error) {
    throw new Error(
      `could not start (${error instanceof Error ? error.message : String(error)}). Heavy-provider install steps run as POSIX shell with /bin/bash \u2014 on Windows install Git Bash, or run the service manually and add it with "Use a detected instance".`
    );
  }
}
function apply(ctx, config = {}) {
  const logger = ctx.logger("enpoi-heavy-providers");
  const home = homedir();
  const profile = ctx.get("profileContext");
  const dshHome = typeof profile?.home === "string" && profile.home !== "" ? profile.home : join5(home, ".dsh");
  const profileDir = profileDirectory(ctx, config);
  const problems = manifestProblems();
  if (problems.length > 0) {
    for (const problem of problems) logger.warn(`[enpoi-heavy-providers] ${problem}`);
  }
  const jobs = new HeavyJobManager({
    dir: join5(dshHome, "cache", "heavy-jobs"),
    run: (step) => runStep(ctx, step, home, dshHome, profileDir)
  });
  ctx.on("webserver/index-inject", (table) => {
    const row = overlayInjectionRow(dshHome);
    if (row !== void 0) table.push(row);
  });
  new HeavyProvidersService(ctx, {
    deps: () => ({
      home,
      dshHome,
      settings: ctx.get("settings"),
      credentials: ctx.get("credentials"),
      llm: ctx.get("llm"),
      jobs,
      profileDir,
      // Host installer ownership readers and issuers: every local install
      // completed by the harness acquires a verified receipt and is tracked.
      installHelperPath: INSTALL_HELPER_PATH,
      readInstallReceipt: async (id) => providerInstallReceipt(dshHome, id),
      issueInstallReceipt: async (id) => issueHostInstallReceipt(dshHome, id),
      clearInstallReceipt: async (id) => clearHostInstallReceipt(dshHome, id),
      readInstallCredential: async (id) => id === CLIPROXYAPI_ID ? cliproxyapiCredential(dshHome) : void 0,
      readInstallPaths: async (id) => id === CLIPROXYAPI_ID ? cliproxyapiInstallPaths(dshHome) : void 0,
      installPreflight: async (id) => id === CLIPROXYAPI_ID ? cliproxyapiInstallPreflight(dshHome) : void 0,
      fetchImpl: globalThis.fetch,
      runStep: (step) => runStep(ctx, step, home, dshHome, profileDir)
    }),
    jobs,
    log: (line) => logger.info(`[enpoi-heavy-providers] ${line}`)
  });
}
export {
  Config,
  INSTALL_HELPER_PATH,
  apply,
  inject,
  installStatusRejectsOwnership,
  name
};
