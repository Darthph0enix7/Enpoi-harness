// src/index.ts
import Schema from "@deepseek-ai/schemastery";

// src/presets.ts
var BUILT_IN_PRESET_IDS = /* @__PURE__ */ new Set([
  "orchestrator",
  "sysadmin",
  "creator",
  "standard",
  "ptc",
  "minimal",
  "cordis"
]);
var MAX_SUFFIX_CHARS = 32768;
function isPresetId(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}
function pluginRows(config) {
  return Array.isArray(config.plugins) ? config.plugins : [];
}
function personaRow(config) {
  return pluginRows(config).find((row) => row.id === "persona");
}
function personaSuffixOf(config) {
  if (config === void 0) return void 0;
  const suffix = personaRow(config)?.config?.suffix;
  return typeof suffix === "string" ? suffix : void 0;
}
function hasSharedPersona(config) {
  if (config === void 0) return false;
  const prefix = personaRow(config)?.config?.prefix;
  return typeof prefix === "string" && prefix !== "";
}
function withPersonaSuffix(plugins, suffix) {
  const copy = structuredClone(Array.isArray(plugins) ? plugins : []);
  const persona = copy.find((row) => row.id === "persona");
  if (persona === void 0 || persona.config === void 0) {
    throw new Error("preset declares no persona row");
  }
  const prefix = persona.config.prefix;
  if (typeof prefix !== "string" || prefix === "") {
    throw new Error("preset persona declares no shared prefix");
  }
  persona.config = { ...persona.config, prefix, suffix };
  return copy;
}
function nextPresetOrder(configs) {
  let max = 0;
  for (const config of configs) {
    if (typeof config.order === "number" && Number.isFinite(config.order)) max = Math.max(max, config.order);
  }
  return max + 1;
}
function newPresetConfig(base, input) {
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    order: input.order,
    plugins: withPersonaSuffix(base.plugins, input.suffix)
  };
}
function validatePresetInput(input, requireId) {
  if (requireId) {
    if (input.id === void 0 || input.id === "") return 'missing or invalid "id"';
    if (!isPresetId(input.id)) return `invalid preset id "${input.id}": expected kebab-case ([a-z0-9]+(-[a-z0-9]+)*)`;
    if (input.id.length > 48) return `preset id "${input.id}" is longer than 48 characters`;
    if (BUILT_IN_PRESET_IDS.has(input.id)) return `preset id "${input.id}" is reserved by a shipped preset`;
  }
  if (input.name === "") return 'missing or invalid "name"';
  if (input.name.length > 64) return "preset name is longer than 64 characters";
  if (input.description.length > 400) return "preset description is longer than 400 characters";
  if (input.suffix === "") return 'missing or invalid "suffix"';
  if (input.suffix.length > MAX_SUFFIX_CHARS) return `persona is longer than ${MAX_SUFFIX_CHARS} characters`;
  return void 0;
}

// src/index.ts
var name = "enpoi-preset-authoring";
var inject = ["webServer", "webRuntime"];
var Config = Schema.object({});
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
var PresetError = class extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
};
function requireString(payload, key, allowEmpty = false) {
  const record = payload;
  const value = record?.[key];
  if (typeof value !== "string" || !allowEmpty && value.trim() === "") {
    throw new PresetError("bad-request", `missing or invalid "${key}"`, 400);
  }
  return value.trim();
}
var MAX_BODY_BYTES = 512 * 1024;
async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new PresetError("bad-request", "request body too large", 413);
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PresetError("bad-request", "malformed JSON body", 400);
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
  const err = error instanceof PresetError ? error : new PresetError("internal", error instanceof Error ? error.message : String(error), 500);
  writeJson(res, err.status, { ok: false, error: { code: err.code, message: err.message } });
}
function presetRowId(id) {
  return `preset-${id}`;
}
function presetIdOf(rowId) {
  return rowId.slice("preset-".length);
}
function requireEditor(ctx) {
  const editor = ctx.get("configEditor");
  if (editor === void 0 || typeof editor.insert !== "function" || typeof editor.remove !== "function") {
    throw new PresetError("internal", "profile config editor is unavailable", 500);
  }
  return editor;
}
function entryConfig(entry) {
  return entry.options.config ?? {};
}
function presetEntries(editor) {
  return editor.entries().filter((entry) => entry.options.id.startsWith("preset-")).map((entry) => ({ entry, id: presetIdOf(entry.options.id), config: entryConfig(entry) })).sort((left, right) => left.id.localeCompare(right.id));
}
function authoringRow(id, entry, config) {
  return {
    id,
    rowId: entry.options.id,
    name: typeof config.name === "string" && config.name !== "" ? config.name : id,
    description: typeof config.description === "string" ? config.description : "",
    order: typeof config.order === "number" ? config.order : void 0,
    builtIn: BUILT_IN_PRESET_IDS.has(id),
    disabled: entry.options.disabled === true,
    hasPersona: hasSharedPersona(config),
    suffixChars: (personaSuffixOf(config) ?? "").length
  };
}
function findPreset(editor, id) {
  const found = editor.entries().find((entry) => entry.options.id === presetRowId(id));
  return found === void 0 ? void 0 : { entry: found, config: entryConfig(found) };
}
function apply(ctx, _config) {
  const trustedHosts = ctx.get("webRuntime")?.trustedHosts ?? [];
  const api = {
    "presets.list": async () => {
      const editor = requireEditor(ctx);
      return {
        presets: presetEntries(editor).map(({ entry, id, config }) => authoringRow(id, entry, config))
      };
    },
    "presets.get": async (payload) => {
      const id = requireString(payload, "id");
      const editor = requireEditor(ctx);
      const found = findPreset(editor, id);
      if (found === void 0) throw new PresetError("not-found", `preset "${id}" does not exist`, 404);
      return {
        ...authoringRow(id, found.entry, found.config),
        suffix: personaSuffixOf(found.config) ?? ""
      };
    },
    "presets.create": async (payload) => {
      const id = requireString(payload, "id");
      const name2 = requireString(payload, "name");
      const description = requireString(payload, "description", true);
      const suffix = requireString(payload, "suffix");
      const baseId = requireString(payload, "base");
      const problem = validatePresetInput({ id, name: name2, description, suffix }, true);
      if (problem !== void 0) throw new PresetError("bad-request", problem, 400);
      const editor = requireEditor(ctx);
      const base = findPreset(editor, baseId);
      if (base === void 0) throw new PresetError("not-found", `base preset "${baseId}" does not exist`, 404);
      if (findPreset(editor, id) !== void 0) {
        throw new PresetError("exists", `preset "${id}" already exists`, 409);
      }
      let config;
      try {
        config = newPresetConfig(base.config, {
          id,
          name: name2,
          description: description === "" ? `Custom preset cloned from ${baseId}` : description,
          suffix,
          order: nextPresetOrder(presetEntries(editor).map((row) => row.config))
        });
      } catch (error) {
        throw new PresetError("bad-request", `cannot clone base preset "${baseId}": ${error instanceof Error ? error.message : String(error)}`, 400);
      }
      await editor.insert({ id: presetRowId(id), name: "@deepseek-ai/dsh-agent-preset", config });
      return { id, rowId: presetRowId(id) };
    },
    "presets.update": async (payload) => {
      const id = requireString(payload, "id");
      const name2 = requireString(payload, "name");
      const description = requireString(payload, "description", true);
      const suffix = requireString(payload, "suffix");
      if (BUILT_IN_PRESET_IDS.has(id)) {
        throw new PresetError("protected", `preset "${id}" is a shipped preset and cannot be edited`, 400);
      }
      const problem = validatePresetInput({ name: name2, description, suffix }, false);
      if (problem !== void 0) throw new PresetError("bad-request", problem, 400);
      const editor = requireEditor(ctx);
      const found = findPreset(editor, id);
      if (found === void 0) throw new PresetError("not-found", `preset "${id}" does not exist`, 404);
      await editor.edit(found.entry, (current) => ({
        ...current,
        name: name2,
        description,
        plugins: withPersonaSuffix(current.plugins, suffix)
      }));
      return { id };
    },
    "presets.delete": async (payload) => {
      const id = requireString(payload, "id");
      if (!isPresetId(id)) {
        throw new PresetError("bad-request", `invalid preset id "${id}"`, 400);
      }
      if (BUILT_IN_PRESET_IDS.has(id)) {
        throw new PresetError("protected", `preset "${id}" is a shipped preset and cannot be deleted`, 400);
      }
      const editor = requireEditor(ctx);
      if (findPreset(editor, id) === void 0) {
        throw new PresetError("not-found", `preset "${id}" does not exist`, 404);
      }
      await editor.remove(presetRowId(id));
      return { id };
    }
  };
  ctx.effect(() => {
    const webServer = ctx.get("webServer");
    if (webServer?.register === void 0) return () => {
    };
    const dispose = webServer.register({
      kind: "prefix",
      path: "/sidebar/presets",
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
        const method = pathname.startsWith("/sidebar/presets/") ? pathname.slice("/sidebar/presets/".length) : void 0;
        if (method === void 0 || method.includes("/")) {
          writeError(httpRes, new PresetError("not-found", "unknown presets method", 404));
          return;
        }
        try {
          const payload = await readJsonBody(httpReq);
          const handler = api[method];
          if (handler === void 0) {
            throw new PresetError("not-found", `unknown presets method "${method}"`, 404);
          }
          writeOk(httpRes, await handler(payload));
        } catch (error) {
          writeError(httpRes, error);
        }
      }
    });
    return () => {
      void dispose;
    };
  }, "dsh-enpoi-preset-authoring: /sidebar/presets routes");
}
export {
  Config,
  apply,
  inject,
  name
};
