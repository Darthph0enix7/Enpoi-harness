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
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateIn = (member, obj) => Object(obj) !== obj ? __typeError('Cannot use the "in" operator on this value') : member.has(obj);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), setter ? setter.call(obj, value) : member.set(obj, value), value);
var __privateMethod = (obj, member, method) => (__accessCheck(obj, member, "access private method"), method);

// src/index.ts
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
var name = "enpoi-git";
var inject = [];
var DIFF_MAX_BYTES = 200 * 1024;
var GIT_TIMEOUT_MS = 1e4;
var GIT_MAX_BUFFER = 8 * 1024 * 1024;
var LOG_DEFAULT_LIMIT = 20;
var LOG_MAX_LIMIT = 100;
function diag(line) {
  try {
    const home = process.env.DSH_HOME ?? process.env.HOME ?? "/tmp";
    const dir = join(home.endsWith(".dsh") ? home : join(home, ".dsh"), "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "enpoi-git.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${line}
`);
  } catch {
  }
}
async function runGit(cwd, args) {
  try {
    const { stdout } = await new Promise((resolve, reject) => {
      execFile("git", [...args], {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }
      }, (error, stdout2, stderr) => {
        if (error !== null) reject(Object.assign(error, { stdout: stdout2, stderr }));
        else resolve({ stdout: stdout2, stderr });
      });
    });
    return { ok: true, stdout };
  } catch (error) {
    const failure = error;
    if (failure.stdout !== void 0 && failure.stdout !== "") {
      return { ok: true, stdout: failure.stdout };
    }
    return { ok: false, stdout: "" };
  }
}
function validCwd(cwd) {
  return typeof cwd === "string" && cwd !== "" && isAbsolute(cwd);
}
function emptyStatus() {
  return { repo: false, branch: "", ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0 };
}
function parseChanges(stdout) {
  const fields = stdout.split("\0");
  const rows = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? "";
    if (field.length < 3) continue;
    const code = field.slice(0, 2);
    const path = field.slice(3);
    if (path === "") continue;
    rows.push({
      path,
      code,
      staged: code[0] !== " " && code[0] !== "?",
      untracked: code === "??"
    });
    if (code[0] === "R" || code[0] === "C") index += 1;
  }
  return rows;
}
async function currentBranch(cwd) {
  const symbolic = await runGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (symbolic.ok && symbolic.stdout.trim() !== "") return symbolic.stdout.trim();
  const sha = await runGit(cwd, ["rev-parse", "--short", "HEAD"]);
  return sha.ok ? sha.stdout.trim() : "";
}
async function aheadBehind(cwd) {
  const counts = await runGit(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
  if (!counts.ok) return { ahead: 0, behind: 0 };
  const [behind, ahead] = counts.stdout.trim().split(/\s+/);
  return { ahead: Number(ahead ?? 0) || 0, behind: Number(behind ?? 0) || 0 };
}
var _diff_dec, _changes_dec, _log_dec, _branches_dec, _status_dec, _a, _init;
var EnpoiGitService = class extends (_a = TypertRemoteService, _status_dec = [Remote], _branches_dec = [Remote], _log_dec = [Remote], _changes_dec = [Remote], _diff_dec = [Remote], _a) {
  /**
   * @param ctx - owning Host Context (Typert binding is installed by the base).
   */
  constructor(ctx) {
    super(ctx, "enpoiGit");
    __runInitializers(_init, 5, this);
  }
  async status(cwd) {
    if (!validCwd(cwd)) return emptyStatus();
    const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok || inside.stdout.trim() !== "true") return emptyStatus();
    const listed = await runGit(cwd, ["status", "--porcelain=v1", "-z", "-uall"]);
    if (!listed.ok) return { ...emptyStatus(), repo: true, branch: await currentBranch(cwd) };
    const changes = parseChanges(listed.stdout);
    const position = await aheadBehind(cwd);
    return {
      repo: true,
      branch: await currentBranch(cwd),
      ahead: position.ahead,
      behind: position.behind,
      staged: changes.filter((change) => change.staged).length,
      unstaged: changes.filter((change) => !change.untracked && change.code[1] !== " ").length,
      untracked: changes.filter((change) => change.untracked).length
    };
  }
  async branches(cwd) {
    if (!validCwd(cwd)) return { current: "", names: [] };
    const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok || inside.stdout.trim() !== "true") return { current: "", names: [] };
    const current = await currentBranch(cwd);
    const refs = await runGit(cwd, ["for-each-ref", "refs/heads", "--format=%(refname:short)"]);
    if (!refs.ok) return { current, names: current === "" ? [] : [current] };
    const names = refs.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    names.sort((left, right) => left.localeCompare(right));
    const ordered = current !== "" ? [current, ...names.filter((name2) => name2 !== current)] : names;
    return { current, names: ordered };
  }
  async log(cwd, limit) {
    if (!validCwd(cwd)) return { entries: [] };
    const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok || inside.stdout.trim() !== "true") return { entries: [] };
    const requested = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : LOG_DEFAULT_LIMIT;
    const bounded = Math.min(Math.max(requested, 1), LOG_MAX_LIMIT);
    const log = await runGit(cwd, [
      "log",
      `-n${bounded}`,
      "--no-color",
      "--pretty=format:%H%x1f%s%x1f%an%x1f%aI%x1e"
    ]);
    if (!log.ok) return { entries: [] };
    const entries = [];
    for (const record of log.stdout.split("")) {
      const trimmed = record.replace(/^\n/, "");
      if (trimmed === "") continue;
      const [sha = "", subject = "", author = "", date = ""] = trimmed.split("");
      if (sha === "") continue;
      entries.push({ sha, subject, author, date });
    }
    return { entries };
  }
  async changes(cwd) {
    if (!validCwd(cwd)) return { files: [] };
    const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok || inside.stdout.trim() !== "true") return { files: [] };
    const listed = await runGit(cwd, ["status", "--porcelain=v1", "-z", "-uall"]);
    if (!listed.ok) return { files: [] };
    return { files: parseChanges(listed.stdout) };
  }
  async diff(cwd, path) {
    if (!validCwd(cwd)) return { text: "", truncated: false };
    const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok || inside.stdout.trim() !== "true") return { text: "", truncated: false };
    const target = typeof path === "string" && path !== "" ? path : void 0;
    let result;
    if (target === void 0) {
      result = await runGit(cwd, ["diff", "HEAD", "--no-color", "--"]);
    } else {
      result = await runGit(cwd, ["diff", "HEAD", "--no-color", "--", target]);
      if (result.ok && result.stdout.trim() === "") {
        result = await runGit(cwd, ["diff", "--no-index", "--no-color", "--", "/dev/null", target]);
      }
    }
    if (!result.ok) return { text: "", truncated: false };
    const bytes = Buffer.from(result.stdout, "utf8");
    if (bytes.byteLength <= DIFF_MAX_BYTES) return { text: result.stdout, truncated: false };
    return { text: bytes.subarray(0, DIFF_MAX_BYTES).toString("utf8"), truncated: true };
  }
};
_init = __decoratorStart(_a);
__decorateElement(_init, 1, "status", _status_dec, EnpoiGitService);
__decorateElement(_init, 1, "branches", _branches_dec, EnpoiGitService);
__decorateElement(_init, 1, "log", _log_dec, EnpoiGitService);
__decorateElement(_init, 1, "changes", _changes_dec, EnpoiGitService);
__decorateElement(_init, 1, "diff", _diff_dec, EnpoiGitService);
__decoratorMetadata(_init, EnpoiGitService);
function apply(ctx) {
  ctx.plugin(EnpoiGitService);
  diag("enpoiGit remote mounted (enpoiGit.status/branches/log/changes/diff)");
}
export {
  apply,
  inject,
  name
};
