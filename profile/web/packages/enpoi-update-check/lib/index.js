var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __knownSymbol = (name2, symbol) => (symbol = Symbol[name2]) ? symbol : /* @__PURE__ */ Symbol.for("Symbol." + name2);
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
var UPDATE_CHECK_NAMESPACE = "updateCheck";
var _dismiss_dec, _checkNow_dec, _status_dec, _a, _init;
var UpdateCheckService = class extends (_a = TypertRemoteService, _status_dec = [Remote], _checkNow_dec = [Remote], _dismiss_dec = [Remote], _a) {
  /**
   * @param ctx - owning context (service registration is automatic).
   * @param options - the core that owns the status.
   */
  constructor(ctx, options) {
    super(ctx, UPDATE_CHECK_NAMESPACE);
    __runInitializers(_init, 5, this);
    __publicField(this, "core");
    this.core = options.core;
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
};
_init = __decoratorStart(_a);
__decorateElement(_init, 1, "status", _status_dec, UpdateCheckService);
__decorateElement(_init, 1, "checkNow", _checkNow_dec, UpdateCheckService);
__decorateElement(_init, 1, "dismiss", _dismiss_dec, UpdateCheckService);
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
import { mkdirSync, readFileSync as readFileSync2, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
function readDismissedVersion(file) {
  try {
    const record = JSON.parse(readFileSync2(file, "utf8"));
    return typeof record.version === "string" && record.version !== "" ? record.version : null;
  } catch {
    return null;
  }
}
function writeDismissedVersion(file, version, now = () => /* @__PURE__ */ new Date()) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.tmp.${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify({ version, at: now().toISOString() }, null, 2)}
`);
    renameSync(temporary, file);
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
    ctx.plugin(UpdateCheckService, { core });
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
  UPDATE_CHECK_NAMESPACE,
  UpdateCheckCore,
  UpdateCheckService,
  apply,
  catalogUrl,
  compareVersions,
  fetchCatalog,
  inject,
  jitteredDelay,
  name,
  parseCatalogDocument,
  readDismissedVersion,
  readInstallIdentity,
  startUpdateCheckSchedule,
  writeDismissedVersion
};
