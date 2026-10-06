// src/index.ts
import Schema from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { join, dirname, basename, resolve, isAbsolute, relative } from "node:path";
import { mkdir, rename, stat, writeFile, rm, open, readFile, readdir } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { isSkillName } from "@deepseek-ai/dsh-skill";
var name = "enpoi-fs-ops";
var inject = ["webServer", "webRuntime", "sessions"];
var TRASH_ROOT = join(homedir(), ".dsh", "trash", "sidebar");
function editorBackupPath(sha256) {
  return join(homedir(), ".dsh", "file-history", "editor", sha256);
}
var MAX_READ_BYTES = 4 * 1024 * 1024;
var MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;
function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
async function readAtMost(handle, length) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}
async function writeFileAtomic(target, bytes, mode) {
  const dir = dirname(target);
  const tmp = join(dir, `${basename(target)}.dsh-tmp-${process.pid}-${randomUUID().slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  let handle;
  try {
    handle = await open(tmp, "w", mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = void 0;
    await rename(tmp, target);
  } catch (error) {
    if (handle !== void 0) await handle.close().catch(() => {
    });
    await rm(tmp, { force: true }).catch(() => {
    });
    throw new FsOpsError("fs-error", `cannot write "${target}": ${error instanceof Error ? error.message : String(error)}`, 400);
  }
}
async function backupBytes(bytes) {
  const dest = editorBackupPath(sha256Of(bytes));
  try {
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, bytes, { flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") return dest;
    throw new FsOpsError("fs-error", `cannot back up existing file: ${error instanceof Error ? error.message : String(error)}`, 400);
  }
  return dest;
}
var Config = Schema.object({
  /** Skills directory the `skills.*` routes manage. Defaults to `$DSH_HOME/skills`. */
  skillsDir: Schema.string()
});
var PROTECTED_SKILL_NAMES = /* @__PURE__ */ new Set([
  "tier1-workflow",
  "tier2-workflow",
  "tier3-workflow"
]);
var MAX_SKILL_BYTES = 1024 * 1024;
var SKILL_FILE_NAME = "SKILL.md";
function resolveSkillsRoot(config) {
  if (typeof config.skillsDir === "string" && config.skillsDir !== "") return resolve(config.skillsDir);
  return dshHomePath("skills");
}
function requireSkillName(payload) {
  const name2 = requireString(payload, "name");
  if (!isSkillName(name2)) {
    throw new FsOpsError("bad-request", `invalid skill name "${name2}": expected kebab-case ([a-z0-9]+(-[a-z0-9]+)*)`, 400);
  }
  return name2;
}
function requireField(payload, key, allowEmpty = false) {
  const record = payload;
  const value = record?.[key];
  if (typeof value !== "string" || !allowEmpty && value.trim() === "") {
    throw new FsOpsError("bad-request", `missing or invalid "${key}"`, 400);
  }
  return value;
}
function requireContained(root, target) {
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new FsOpsError("fs-error", `skill path "${target}" escapes the skills directory`, 400);
  }
  return target;
}
function isProtectedSkill(entry) {
  return PROTECTED_SKILL_NAMES.has(entry.name) || PROTECTED_SKILL_NAMES.has(entry.entry);
}
function requireUnprotectedSkill(name2, action) {
  if (!PROTECTED_SKILL_NAMES.has(name2)) return;
  throw new FsOpsError(
    "protected",
    `skill "${name2}" is a shipped default of this profile and cannot be ${action}; it lives in the profile's skills dir`,
    400
  );
}
function splitFrontmatter(raw) {
  const lines = raw.split("\n");
  if ((lines[0] ?? "").replace(/\r$/, "") !== "---") return void 0;
  for (let index = 1; index < lines.length; index++) {
    if (lines[index]?.replace(/\r$/, "") === "---") {
      return { lines: lines.slice(1, index).map((line) => line.replace(/\r$/, "")), body: lines.slice(index + 1).join("\n") };
    }
  }
  return void 0;
}
function frontmatterValue(lines, key) {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (/^\s/.test(line) || line === "") continue;
    const match = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]?(.*)$/.exec(line);
    if (match === null || match[1] !== key) continue;
    return decodeScalar(lines, index, match[2] ?? "");
  }
  return void 0;
}
function decodeScalar(lines, index, rest) {
  if (/^[|>][+-]?[ \t]*$/.test(rest)) {
    const block = [];
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const line = lines[cursor] ?? "";
      if (line.trim() !== "" && !/^\s/.test(line)) break;
      block.push(line);
    }
    while (block.length > 0 && (block[block.length - 1] ?? "").trim() === "") block.pop();
    const indents = block.filter((line) => line.trim() !== "").map((line) => line.length - line.trimStart().length);
    const indent = indents.length === 0 ? 0 : Math.min(...indents);
    const parts = block.map((line) => line.slice(Math.min(indent, line.length - line.trimStart().length)));
    return (rest.startsWith(">") ? parts.join(" ") : parts.join("\n")).trim();
  }
  if (rest.startsWith('"')) {
    let escaped = false;
    for (let cursor = 1; cursor < rest.length; cursor++) {
      const char = rest[cursor];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') return decodeDoubleQuoted(rest.slice(1, cursor));
    }
    return rest.slice(1);
  }
  if (rest.startsWith("'")) {
    const end = rest.indexOf("'", 1);
    if (end >= 0) return rest.slice(1, end).replace(/''/g, "'");
    return rest.slice(1);
  }
  const comment = rest.search(/\s#/);
  return (comment >= 0 ? rest.slice(0, comment) : rest).trim();
}
function decodeDoubleQuoted(value) {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const char = value[index] ?? "";
    if (char !== "\\") {
      result += char;
      continue;
    }
    const next = value[++index] ?? "";
    switch (next) {
      case "n":
        result += "\n";
        break;
      case "r":
        result += "\r";
        break;
      case "t":
        result += "	";
        break;
      case '"':
        result += '"';
        break;
      case "\\":
        result += "\\";
        break;
      case "/":
        result += "/";
        break;
      case "0":
        result += "\0";
        break;
      case "u": {
        const hex = value.slice(index + 1, index + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          result += String.fromCharCode(Number.parseInt(hex, 16));
          index += 4;
        } else {
          result += "u";
        }
        break;
      }
      default:
        result += next;
    }
  }
  return result;
}
function yamlQuote(value) {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `"${escaped}"`;
}
function splitFlowSequence(inner) {
  const parts = [];
  let current = "";
  let quote;
  let escaped = false;
  for (const char of inner) {
    if (quote !== void 0) {
      current += char;
      if (quote === '"') {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quote = void 0;
      } else if (char === "'") {
        quote = void 0;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}
function decodeInlineScalar(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) {
    let escaped = false;
    for (let cursor = 1; cursor < value.length; cursor++) {
      const char = value[cursor];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') return decodeDoubleQuoted(value.slice(1, cursor));
    }
    return value.slice(1);
  }
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    if (end >= 0) return value.slice(1, end).replace(/''/g, "'");
    return value.slice(1);
  }
  const comment = value.search(/\s#/);
  return (comment >= 0 ? value.slice(0, comment) : value).trim();
}
function frontmatterStringArray(lines, key) {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (/^\s/.test(line) || line === "") continue;
    const match = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]?(.*)$/.exec(line);
    if (match === null || match[1] !== key) continue;
    const rest = (match[2] ?? "").trim();
    if (rest.startsWith("[")) {
      const end = rest.lastIndexOf("]");
      if (end < 0) return [];
      return splitFlowSequence(rest.slice(1, end)).map(decodeInlineScalar).filter((entry) => entry !== "");
    }
    const entries = [];
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const item = lines[cursor] ?? "";
      if (item.trim() === "") continue;
      if (!/^\s/.test(item)) break;
      const bullet = /^\s*-[ \t]*(.*)$/.exec(item);
      if (bullet === null) continue;
      const value = decodeInlineScalar(bullet[1] ?? "");
      if (value !== "") entries.push(value);
    }
    return entries;
  }
  return void 0;
}
function isBareYamlScalar(value) {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value) && !/^(?:true|false|null|yes|no|on|off|~)$/i.test(value);
}
function yamlArray(values) {
  return `[${values.map((value) => isBareYamlScalar(value) ? value : yamlQuote(value)).join(", ")}]`;
}
function parseSkillMarkdown(raw) {
  const frontmatter = splitFrontmatter(raw);
  if (frontmatter === void 0) return { frontmatter: void 0, name: void 0, description: void 0, mcp: void 0, body: raw.trim() };
  return {
    frontmatter: frontmatter.lines,
    name: frontmatterValue(frontmatter.lines, "name"),
    description: frontmatterValue(frontmatter.lines, "description"),
    mcp: frontmatterStringArray(frontmatter.lines, "mcp"),
    body: frontmatter.body.trim()
  };
}
function normalizeBody(body) {
  return body.replace(/\r\n/g, "\n").replace(/^\n+/, "").replace(/\s+$/, "");
}
function skillFileText(existing, name2, description, body, mcp) {
  const bodyText = normalizeBody(body);
  const mcpLine = mcp === void 0 || mcp.length === 0 ? void 0 : `mcp: ${yamlArray(mcp)}`;
  if (existing?.frontmatter === void 0 || existing.name === void 0) {
    const fresh = [`name: ${name2}`, `description: ${yamlQuote(description)}`];
    if (mcpLine !== void 0) fresh.push(mcpLine);
    return `---
${fresh.join("\n")}
---
${bodyText === "" ? "" : `
${bodyText}
`}`;
  }
  const lines = [...existing.frontmatter];
  const index = lines.findIndex((line) => /^description[ \t]*:/.test(line));
  if (index >= 0) {
    let end = index + 1;
    while (end < lines.length && /^\s/.test(lines[end] ?? "")) end++;
    lines.splice(index, end - index, `description: ${yamlQuote(description)}`);
  } else {
    lines.push(`description: ${yamlQuote(description)}`);
  }
  if (mcp !== void 0) {
    const mcpIndex = lines.findIndex((line) => /^mcp[ \t]*:/.test(line));
    if (mcpIndex >= 0) {
      let end = mcpIndex + 1;
      while (end < lines.length && /^\s/.test(lines[end] ?? "")) end++;
      if (mcpLine === void 0) lines.splice(mcpIndex, end - mcpIndex);
      else lines.splice(mcpIndex, end - mcpIndex, mcpLine);
    } else if (mcpLine !== void 0) {
      lines.push(mcpLine);
    }
  }
  return `---
${lines.join("\n")}
---
${bodyText === "" ? "" : `
${bodyText}
`}`;
}
function readMcpField(payload) {
  const record = payload;
  if (record === null || record.mcp === void 0) return void 0;
  if (!Array.isArray(record.mcp)) {
    throw new FsOpsError("bad-request", '"mcp" must be an array of server ids', 400);
  }
  const values = [];
  for (const entry of record.mcp) {
    if (typeof entry !== "string") {
      throw new FsOpsError("bad-request", '"mcp" entries must be strings', 400);
    }
    const value = entry.trim();
    if (value === "") {
      throw new FsOpsError("bad-request", '"mcp" entries must be non-empty server ids', 400);
    }
    if (!values.includes(value)) values.push(value);
  }
  return values;
}
async function readSkillText(path) {
  const info = await stat(path);
  if (info.size > MAX_SKILL_BYTES) {
    throw new FsOpsError("too-large", `"${path}" is larger than ${MAX_SKILL_BYTES} bytes`, 413);
  }
  return await readFile(path, "utf8");
}
function requireSkillSize(text) {
  if (Buffer.byteLength(text, "utf8") > MAX_SKILL_BYTES) {
    throw new FsOpsError("too-large", `skill file would exceed ${MAX_SKILL_BYTES} bytes`, 413);
  }
}
async function readSkillEntry(path, entry, rootPath, format) {
  let raw;
  try {
    raw = await readSkillText(path);
  } catch (error) {
    if (error instanceof FsOpsError) return void 0;
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
  const parsed = parseSkillMarkdown(raw);
  if (parsed.name === void 0 || !isSkillName(parsed.name) || parsed.description === void 0 || parsed.description === "") return void 0;
  return { entry, name: parsed.name, description: parsed.description, mcp: parsed.mcp ?? [], path, rootPath, format };
}
async function listSkillEntries(root) {
  let dirents;
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new FsOpsError("fs-error", `cannot list skills in "${root}": ${error instanceof Error ? error.message : String(error)}`, 400);
  }
  const entries = [];
  const seen = /* @__PURE__ */ new Set();
  for (const dirent of dirents.sort((left, right) => left.name.localeCompare(right.name))) {
    if (dirent.isDirectory()) {
      const entry = await readSkillEntry(join(root, dirent.name, SKILL_FILE_NAME), dirent.name, join(root, dirent.name), "directory");
      if (entry !== void 0 && !seen.has(entry.name)) {
        seen.add(entry.name);
        entries.push(entry);
      }
    } else if (dirent.isFile() && dirent.name.endsWith(".md")) {
      const stem = dirent.name.slice(0, -".md".length);
      if (stem === "") continue;
      const path = join(root, dirent.name);
      const entry = await readSkillEntry(path, stem, path, "file");
      if (entry !== void 0 && !seen.has(entry.name)) {
        seen.add(entry.name);
        entries.push(entry);
      }
    }
  }
  return entries;
}
async function findSkillEntry(root, name2) {
  const direct = [
    { path: join(root, name2, SKILL_FILE_NAME), rootPath: join(root, name2), format: "directory" },
    { path: join(root, `${name2}.md`), rootPath: join(root, `${name2}.md`), format: "file" }
  ];
  for (const candidate of direct) {
    const entry = await readSkillEntry(candidate.path, name2, candidate.rootPath, candidate.format);
    if (entry !== void 0) return entry;
  }
  return (await listSkillEntries(root)).find((entry) => entry.name === name2);
}
async function trashSkill(entry) {
  const dest = join(dshHomePath("trash", "skills"), `${Date.now()}-${randomUUID()}-${basename(entry.rootPath)}`);
  try {
    await mkdir(dirname(dest), { recursive: true });
    await rename(entry.rootPath, dest);
  } catch (error) {
    throw new FsOpsError("fs-error", `cannot delete skill "${entry.name}": ${error instanceof Error ? error.message : String(error)}`, 400);
  }
  return dest;
}
async function readRegistrySkills(ctx, sessionId) {
  if (sessionId === void 0 || sessionId === "") return { skills: [] };
  const catalog = ctx.get("sessionSkillCatalog");
  if (catalog?.list === void 0) return { skills: [], error: "skill catalog service is unavailable" };
  try {
    const value = await catalog.list({ sessionId }, new AbortController().signal);
    const skills = Array.isArray(value.skills) ? value.skills : [];
    return { skills: skills.filter((skill) => isSkillName(skill.name)) };
  } catch (error) {
    return { skills: [], error: error instanceof Error ? error.message : String(error) };
  }
}
function header(headers, name2) {
  const value = headers[name2];
  return typeof value === "string" ? value : void 0;
}
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
function isTrustedRequest(req, trustedHosts) {
  const host = header(req.headers, "host");
  if (host === void 0) return false;
  let hostname;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  if (isLoopbackHostname(hostname)) return true;
  return trustedHosts.some((entry) => {
    try {
      return new URL(`http://${entry}`).hostname === hostname;
    } catch {
      return false;
    }
  });
}
var FsOpsError = class extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
};
function requireString(payload, key) {
  const record = payload;
  const value = record?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new FsOpsError("bad-request", `missing or invalid "${key}"`, 400);
  }
  return value;
}
function requireAbsolute(path) {
  if (!isAbsolute(path)) {
    throw new FsOpsError("fs-error", `"${path}" is not an absolute path`, 400);
  }
  return resolve(path);
}
function settingsDocument(ctx) {
  const path = ctx.get("settings")?.documentPath;
  if (typeof path !== "string" || path === "" || !isAbsolute(path)) return void 0;
  const resolved = resolve(path);
  return { path: resolved, root: dirname(resolved) };
}
function insideSettingsRoot(document, path) {
  const rel = relative(document.root, resolve(path));
  return rel === "" || !rel.startsWith("..") && !isAbsolute(rel);
}
var MAX_LIST_ENTRIES = 2e3;
function requireWorkspacePath(payload, sessions, key = "path") {
  const raw = requireString(payload, key);
  if (isAbsolute(raw)) return resolve(raw);
  return resolve(cwdOf(payload, sessions), raw);
}
function requireValidName(name2) {
  if (name2 === "" || name2 === "." || name2 === ".." || name2.includes("/") || name2.includes("\\")) {
    throw new FsOpsError("bad-request", `invalid name "${name2}"`, 400);
  }
  return name2;
}
var MAX_BODY_BYTES = 2 * MAX_READ_BYTES;
async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new FsOpsError("bad-request", "request body too large", 413);
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new FsOpsError("bad-request", "malformed JSON body", 400);
  }
}
function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value });
}
function writeError(res, error) {
  const err = error instanceof FsOpsError ? error : new FsOpsError("internal", error instanceof Error ? error.message : String(error), 500);
  writeJson(res, err.status, { ok: false, error: { code: err.code, message: err.message } });
}
function cwdOf(payload, sessions) {
  const record = payload;
  const sessionId = typeof record?.sessionId === "string" ? record.sessionId : "";
  const explicit = typeof record?.cwd === "string" && record.cwd !== "" ? record.cwd : void 0;
  if (explicit !== void 0) return explicit;
  const session = sessionId !== "" ? sessions?.get?.(sessionId) : void 0;
  const cwd = session?.header?.cwd;
  if (typeof cwd !== "string" || cwd === "") {
    throw new FsOpsError("fs-error", "no working directory for this session", 400);
  }
  return cwd;
}
function apply(ctx, config) {
  const sessions = ctx.get("sessions");
  const trustedHosts = ctx.get("webRuntime")?.trustedHosts ?? [];
  const api = {
    "settings.document": async () => {
      const document = settingsDocument(ctx);
      if (document === void 0) {
        throw new FsOpsError("not-found", "no settings document is available", 404);
      }
      return document;
    },
    "fs.rename": async (payload) => {
      const cwd = cwdOf(payload, sessions);
      const from = requireAbsolute(requireString(payload, "from"));
      const to = requireAbsolute(requireString(payload, "to"));
      if (from === cwd || relative(cwd, from) === "") {
        throw new FsOpsError("fs-error", "cannot rename the workspace root", 400);
      }
      try {
        await stat(to);
        throw new FsOpsError("fs-error", `"${to}" already exists`, 409);
      } catch (error) {
        if (error instanceof FsOpsError) throw error;
      }
      try {
        await mkdir(dirname(to), { recursive: true });
        await rename(from, to);
      } catch (error) {
        throw new FsOpsError("fs-error", `cannot rename "${from}" \u2192 "${to}": ${error instanceof Error ? error.message : String(error)}`, 400);
      }
      return { ok: true, from, to };
    },
    "fs.delete": async (payload) => {
      const cwd = cwdOf(payload, sessions);
      const path = requireAbsolute(requireString(payload, "path"));
      if (path === cwd || relative(cwd, path) === "") {
        throw new FsOpsError("fs-error", "cannot delete the workspace root", 400);
      }
      const destDir = join(TRASH_ROOT, `${Date.now()}-${randomUUID()}-${basename(path)}`);
      try {
        await mkdir(dirname(destDir), { recursive: true });
        await rename(path, destDir);
      } catch (error) {
        throw new FsOpsError("fs-error", `cannot delete "${path}": ${error instanceof Error ? error.message : String(error)}`, 400);
      }
      return { ok: true, dest: destDir };
    },
    "fs.mkdir": async (payload) => {
      const cwd = cwdOf(payload, sessions);
      const parent = requireAbsolute(requireString(payload, "parent"));
      const name2 = requireValidName(requireString(payload, "name"));
      const target = join(parent, name2);
      if (relative(cwd, target) === "" || relative(cwd, target).startsWith("..")) {
        throw new FsOpsError("fs-error", "new directory must stay inside the workspace", 400);
      }
      try {
        await mkdir(target, { recursive: false });
      } catch (error) {
        throw new FsOpsError("fs-error", `cannot create directory "${target}": ${error instanceof Error ? error.message : String(error)}`, 400);
      }
      return { ok: true, path: target };
    },
    "fs.create": async (payload) => {
      const cwd = cwdOf(payload, sessions);
      const parent = requireAbsolute(requireString(payload, "parent"));
      const name2 = requireValidName(requireString(payload, "name"));
      const target = join(parent, name2);
      if (relative(cwd, target) === "" || relative(cwd, target).startsWith("..")) {
        throw new FsOpsError("fs-error", "new file must stay inside the workspace", 400);
      }
      try {
        await mkdir(parent, { recursive: true });
        await writeFile(target, "", { flag: "wx" });
      } catch (error) {
        if (error.code === "EEXIST") {
          throw new FsOpsError("fs-error", `"${target}" already exists`, 409);
        }
        throw new FsOpsError("fs-error", `cannot create "${target}": ${error instanceof Error ? error.message : String(error)}`, 400);
      }
      return { ok: true, path: target };
    },
    "fs.list": async (payload) => {
      const path = requireAbsolute(requireString(payload, "path"));
      const document = settingsDocument(ctx);
      if (document === void 0 || !insideSettingsRoot(document, path)) {
        throw new FsOpsError("fs-error", `"${path}" is outside the settings document directory`, 400);
      }
      let dirents;
      try {
        dirents = await readdir(path, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") {
          throw new FsOpsError("not-found", `"${path}" does not exist`, 404);
        }
        throw new FsOpsError("fs-error", `cannot list "${path}": ${error instanceof Error ? error.message : String(error)}`, 400);
      }
      const entries = dirents.slice(0, MAX_LIST_ENTRIES).map((dirent) => {
        if (dirent.isDirectory()) return { name: dirent.name, type: "directory" };
        if (dirent.isFile()) return { name: dirent.name, type: "file" };
        return { name: dirent.name, type: "other" };
      });
      return { path, entries, truncated: dirents.length > MAX_LIST_ENTRIES };
    },
    "fs.stat": async (payload) => {
      const path = requireWorkspacePath(payload, sessions);
      try {
        const info = await stat(path);
        return { ok: true, path, mtimeMs: info.mtimeMs, size: info.size, isDir: info.isDirectory() };
      } catch (error) {
        if (error.code === "ENOENT") {
          throw new FsOpsError("not-found", `"${path}" does not exist`, 404);
        }
        throw new FsOpsError("fs-error", `cannot stat "${path}": ${error instanceof Error ? error.message : String(error)}`, 400);
      }
    },
    "fs.download": async (payload) => {
      const path = requireWorkspacePath(payload, sessions);
      let handle;
      try {
        handle = await open(path, "r");
      } catch (error) {
        if (error.code === "ENOENT") {
          throw new FsOpsError("not-found", `"${path}" does not exist`, 404);
        }
        throw new FsOpsError("fs-error", `cannot read "${path}": ${error instanceof Error ? error.message : String(error)}`, 400);
      }
      try {
        const info = await handle.stat();
        if (info.isDirectory()) {
          throw new FsOpsError("fs-error", `"${path}" is a directory`, 400);
        }
        if (info.size > MAX_DOWNLOAD_BYTES) {
          throw new FsOpsError("too-large", `"${path}" is larger than ${MAX_DOWNLOAD_BYTES} bytes`, 413);
        }
        const bytes = await handle.readFile();
        return { base64: bytes.toString("base64"), size: bytes.length, name: basename(path) };
      } finally {
        await handle.close();
      }
    },
    "fs.read": async (payload) => {
      const path = requireWorkspacePath(payload, sessions);
      let handle;
      try {
        handle = await open(path, "r");
      } catch (error) {
        if (error.code === "ENOENT") {
          throw new FsOpsError("not-found", `"${path}" does not exist`, 404);
        }
        throw new FsOpsError("fs-error", `cannot read "${path}": ${error instanceof Error ? error.message : String(error)}`, 400);
      }
      try {
        const info = await handle.stat();
        if (info.isDirectory()) {
          throw new FsOpsError("fs-error", `"${path}" is a directory`, 400);
        }
        const size = info.size;
        const truncated = size > MAX_READ_BYTES;
        const head = await readAtMost(handle, truncated ? MAX_READ_BYTES : size);
        if (head.includes(0)) {
          throw new FsOpsError("not-text", `"${path}" is binary (NUL byte)`, 400);
        }
        let content;
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(head);
        } catch {
          throw new FsOpsError("not-text", `"${path}" is not valid UTF-8 text`, 400);
        }
        let sha256;
        if (!truncated) {
          sha256 = sha256Of(head);
        } else {
          const hash = createHash("sha256");
          const stream = handle.createReadStream({ start: 0, autoClose: false });
          for await (const chunk of stream) hash.update(chunk);
          sha256 = hash.digest("hex");
        }
        return { content, sha256, mtimeMs: info.mtimeMs, size, truncated };
      } finally {
        await handle.close().catch(() => {
        });
      }
    },
    "fs.write": async (payload) => {
      const cwd = cwdOf(payload, sessions);
      const path = requireWorkspacePath(payload, sessions);
      const record = payload;
      const content = record?.content;
      if (typeof content !== "string") {
        throw new FsOpsError("bad-request", 'missing or invalid "content"', 400);
      }
      const rawExpected = record?.expectedSha;
      if (rawExpected !== void 0 && rawExpected !== null && typeof rawExpected !== "string") {
        throw new FsOpsError("bad-request", 'invalid "expectedSha"', 400);
      }
      const expectedSha = typeof rawExpected === "string" ? rawExpected : null;
      const createOnly = rawExpected === null;
      const force = record?.force === true;
      const root = resolve(cwd);
      const rel = relative(root, path);
      const inWorkspace = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
      if (!inWorkspace) {
        const document = settingsDocument(ctx);
        if (document === void 0 || !insideSettingsRoot(document, path)) {
          throw new FsOpsError("fs-error", "file must stay inside the workspace", 400);
        }
      }
      const bytes = Buffer.from(content, "utf8");
      const newSha = sha256Of(bytes);
      let existing = null;
      let mode = 420;
      try {
        const info2 = await stat(path);
        if (info2.isDirectory()) {
          throw new FsOpsError("fs-error", `"${path}" is a directory`, 400);
        }
        existing = await readFile(path);
        mode = info2.mode & 511;
      } catch (error) {
        if (error instanceof FsOpsError) throw error;
        if (error.code !== "ENOENT") {
          throw new FsOpsError("fs-error", `cannot read "${path}": ${error instanceof Error ? error.message : String(error)}`, 400);
        }
      }
      let backup = null;
      if (existing !== null) {
        if (createOnly) {
          throw new FsOpsError("exists", `"${path}" already exists`, 409);
        }
        if (!force && expectedSha !== null && sha256Of(existing) !== expectedSha) {
          throw new FsOpsError("conflict", "file changed on disk since it was read", 409);
        }
        backup = await backupBytes(existing);
      } else if (expectedSha !== null && !force) {
        throw new FsOpsError("conflict", "file changed on disk since it was read", 409);
      }
      await writeFileAtomic(path, bytes, mode);
      const info = await stat(path);
      return { sha256: newSha, mtimeMs: info.mtimeMs, size: bytes.length, backup };
    },
    "skills.list": async (payload) => {
      const root = resolveSkillsRoot(config);
      const entries = await listSkillEntries(root);
      const rows = entries.map((entry) => ({
        name: entry.name,
        entry: entry.entry,
        description: entry.description,
        mcp: entry.mcp,
        path: entry.path,
        format: entry.format,
        source: isProtectedSkill(entry) ? "default" : "profile",
        protected: isProtectedSkill(entry),
        editable: !isProtectedSkill(entry)
      }));
      const record = payload;
      const sessionId = typeof record?.sessionId === "string" && record.sessionId !== "" ? record.sessionId : void 0;
      const registry = await readRegistrySkills(ctx, sessionId);
      const known = new Set(rows.flatMap((row) => [row.name, row.entry]));
      const registryRows = registry.skills.filter((skill) => !known.has(skill.name)).map((skill) => ({
        name: skill.name,
        entry: skill.name,
        description: skill.description,
        mcp: [],
        ...skill.path === void 0 ? {} : { path: skill.path },
        format: "file",
        source: PROTECTED_SKILL_NAMES.has(skill.name) ? "default" : "registry",
        protected: PROTECTED_SKILL_NAMES.has(skill.name),
        editable: false
      }));
      return {
        root,
        skills: [...rows, ...registryRows].sort((left, right) => left.name.localeCompare(right.name)),
        registry: registry.error === void 0 ? { ok: true } : { ok: false, error: registry.error }
      };
    },
    "skills.read": async (payload) => {
      const name2 = requireSkillName(payload);
      const root = resolveSkillsRoot(config);
      const entry = await findSkillEntry(root, name2);
      if (entry === void 0) {
        throw new FsOpsError("not-found", `skill "${name2}" does not exist`, 404);
      }
      const content = await readSkillText(entry.path);
      const parsed = parseSkillMarkdown(content);
      return {
        name: entry.name,
        entry: entry.entry,
        description: parsed.description ?? entry.description,
        mcp: parsed.mcp ?? entry.mcp,
        body: parsed.body,
        content,
        path: entry.path,
        format: entry.format,
        source: isProtectedSkill(entry) ? "default" : "profile",
        protected: isProtectedSkill(entry)
      };
    },
    "skills.create": async (payload) => {
      const name2 = requireSkillName(payload);
      requireUnprotectedSkill(name2, "created");
      const description = requireField(payload, "description").trim();
      const body = requireField(payload, "body", true);
      const mcp = readMcpField(payload);
      const root = resolveSkillsRoot(config);
      const existing = await findSkillEntry(root, name2);
      if (existing !== void 0) {
        throw new FsOpsError("exists", `skill "${name2}" already exists`, 409);
      }
      const targetDir = requireContained(root, join(root, name2));
      const targetFile = requireContained(root, join(targetDir, SKILL_FILE_NAME));
      const text = skillFileText(void 0, name2, description, body, mcp);
      requireSkillSize(text);
      try {
        await mkdir(root, { recursive: true });
        await mkdir(targetDir);
      } catch (error) {
        if (error.code === "EEXIST") {
          throw new FsOpsError("exists", `skill "${name2}" already exists`, 409);
        }
        throw new FsOpsError("fs-error", `cannot create skill "${name2}": ${error instanceof Error ? error.message : String(error)}`, 400);
      }
      try {
        await writeFileAtomic(targetFile, Buffer.from(text, "utf8"), 420);
      } catch (error) {
        await rm(targetDir, { recursive: true, force: true }).catch(() => {
        });
        throw error;
      }
      return { name: name2, path: targetFile };
    },
    "skills.update": async (payload) => {
      const name2 = requireSkillName(payload);
      requireUnprotectedSkill(name2, "edited");
      const description = requireField(payload, "description").trim();
      const body = requireField(payload, "body", true);
      const mcp = readMcpField(payload);
      const root = resolveSkillsRoot(config);
      const entry = await findSkillEntry(root, name2);
      if (entry === void 0) {
        throw new FsOpsError("not-found", `skill "${name2}" does not exist`, 404);
      }
      if (isProtectedSkill(entry)) {
        throw new FsOpsError("protected", `skill "${entry.name}" is a shipped default of this profile and cannot be edited`, 400);
      }
      const raw = await readSkillText(entry.path);
      const parsed = parseSkillMarkdown(raw);
      const base = parsed.frontmatter !== void 0 && parsed.name !== void 0 ? parsed : void 0;
      const text = skillFileText(base, entry.name, description, body, mcp);
      requireSkillSize(text);
      const info = await stat(entry.path);
      await writeFileAtomic(entry.path, Buffer.from(text, "utf8"), info.mode & 511);
      return { name: base?.name ?? entry.name, path: entry.path };
    },
    "skills.delete": async (payload) => {
      const name2 = requireSkillName(payload);
      requireUnprotectedSkill(name2, "deleted");
      const root = resolveSkillsRoot(config);
      const entry = await findSkillEntry(root, name2);
      if (entry === void 0) {
        throw new FsOpsError("not-found", `skill "${name2}" does not exist`, 404);
      }
      if (isProtectedSkill(entry)) {
        throw new FsOpsError("protected", `skill "${entry.name}" is a shipped default of this profile and cannot be deleted`, 400);
      }
      const dest = await trashSkill(entry);
      return { name: entry.name, dest };
    }
  };
  ctx.effect(() => {
    const webServer = ctx.get("webServer");
    if (webServer?.register === void 0) return () => {
    };
    return webServer.register({
      kind: "prefix",
      path: "/sidebar/fsops",
      handler: async (req, res) => {
        const httpReq = req;
        const httpRes = res;
        if (!isTrustedRequest(httpReq, trustedHosts)) {
          writeJson(httpRes, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
          return;
        }
        const contentType = header(httpReq.headers, "content-type") ?? "";
        if (!contentType.toLowerCase().includes("application/json")) {
          writeJson(httpRes, 415, { ok: false, error: { code: "bad-request", message: "content-type must be application/json" } });
          return;
        }
        const origin = header(httpReq.headers, "origin");
        if (origin !== void 0 && origin !== "null") {
          let originHost;
          try {
            originHost = new URL(origin).hostname;
          } catch {
            writeJson(httpRes, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
            return;
          }
          if (!isLoopbackHostname(originHost) && !trustedHosts.some((entry) => {
            try {
              return new URL(`http://${entry}`).hostname === originHost;
            } catch {
              return false;
            }
          })) {
            writeJson(httpRes, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
            return;
          }
        }
        if (httpReq.method !== "POST") {
          writeJson(httpRes, 405, { ok: false, error: { code: "method-error", message: "method not allowed" } });
          return;
        }
        const pathname = new URL(httpReq.url ?? "/", "http://dsh.internal").pathname;
        const method = pathname.startsWith("/sidebar/fsops/") ? pathname.slice("/sidebar/fsops/".length) : void 0;
        if (method === void 0 || method.includes("/")) {
          writeError(httpRes, new FsOpsError("not-found", "unknown fsops method", 404));
          return;
        }
        try {
          const payload = await readJsonBody(httpReq);
          const handler = api[method];
          if (handler === void 0) {
            throw new FsOpsError("not-found", `unknown fsops method "${method}"`, 404);
          }
          writeOk(httpRes, await handler(payload));
        } catch (error) {
          writeError(httpRes, error);
        }
      }
    });
  }, "dsh-enpoi-fs-ops: /sidebar/fsops routes");
}
export {
  Config,
  apply,
  inject,
  name
};
