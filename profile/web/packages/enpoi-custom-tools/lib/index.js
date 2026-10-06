// src/index.ts
import Schema from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readOrchestrationDocument } from "dsh-enpoi-contracts";

// src/render.ts
var CUSTOM_TOOL_PREFIX = "custom_";
var MAX_COMMAND_CHARS = 8192;
var MAX_PARAMS = 16;
var MAX_DESCRIPTION_CHARS = 2e3;
var MAX_NAME_CHARS = 64;
function isCustomToolId(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}
function isParamName(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}
function toolNameOf(id) {
  return `${CUSTOM_TOOL_PREFIX}${id}`;
}
function recordIdOf(toolName) {
  return toolName.startsWith(CUSTOM_TOOL_PREFIX) ? toolName.slice(CUSTOM_TOOL_PREFIX.length) : void 0;
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseCustomToolRecord(value) {
  if (!isRecord(value)) return { error: "entry is not an object" };
  const id = value.id;
  if (typeof id !== "string" || !isCustomToolId(id)) return { error: `invalid id ${JSON.stringify(id)}: expected kebab-case` };
  const name2 = typeof value.name === "string" && value.name.trim() !== "" ? value.name.trim() : id;
  if (name2.length > MAX_NAME_CHARS) return { error: `name is longer than ${MAX_NAME_CHARS} characters` };
  const description = typeof value.description === "string" ? value.description.trim() : "";
  if (description === "") return { error: "description is required" };
  if (description.length > MAX_DESCRIPTION_CHARS) return { error: `description is longer than ${MAX_DESCRIPTION_CHARS} characters` };
  const command = typeof value.command === "string" ? value.command : "";
  if (command.trim() === "") return { error: "command is required" };
  if (command.length > MAX_COMMAND_CHARS) return { error: `command is longer than ${MAX_COMMAND_CHARS} characters` };
  const rawParams = value.params;
  if (rawParams !== void 0 && !Array.isArray(rawParams)) return { error: "params must be an array" };
  const params = [];
  const seen = /* @__PURE__ */ new Set();
  for (const raw of rawParams ?? []) {
    if (!isRecord(raw)) return { error: "each param must be an object" };
    const paramName = raw.name;
    if (typeof paramName !== "string" || !isParamName(paramName)) {
      return { error: `invalid param name ${JSON.stringify(paramName)}: expected kebab-case` };
    }
    if (seen.has(paramName)) return { error: `duplicate param "${paramName}"` };
    seen.add(paramName);
    const type = raw.type;
    if (type !== "string" && type !== "number" && type !== "boolean") {
      return { error: `param "${paramName}" has unsupported type ${JSON.stringify(type)}` };
    }
    params.push({
      name: paramName,
      type,
      required: raw.required === true,
      description: typeof raw.description === "string" ? raw.description : ""
    });
  }
  if (params.length > MAX_PARAMS) return { error: `more than ${MAX_PARAMS} params` };
  return { record: { id, name: name2, description, params, command } };
}
function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function coerceParam(param, value) {
  if (value === void 0 || value === null) {
    if (param.required) return { error: `missing required parameter "${param.name}"` };
    return { text: "" };
  }
  if (param.type === "string") {
    if (typeof value !== "string") return { error: `parameter "${param.name}" must be a string` };
    return { text: value };
  }
  if (param.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return { error: `parameter "${param.name}" must be a finite number` };
    return { text: String(value) };
  }
  if (typeof value !== "boolean") return { error: `parameter "${param.name}" must be a boolean` };
  return { text: value ? "true" : "false" };
}
function renderCommand(record, args) {
  const values = isRecord(args) ? args : {};
  const byName = new Map(record.params.map((param) => [param.name, param]));
  const rendered = record.command.replace(/\{\{([a-z0-9-]+)\}\}/g, (_match, name2) => {
    const param = byName.get(name2);
    if (param === void 0) return `\0unknown:${name2}\0`;
    const coerced = coerceParam(param, values[name2]);
    if (coerced.error !== void 0) return `\0error:${coerced.error}\0`;
    return shellQuote(coerced.text ?? "");
  });
  const unknown = rendered.match(/\u0000unknown:([a-z0-9-]+)\u0000/);
  if (unknown !== null) return { error: `command references unknown parameter "${unknown[1]}"` };
  const failed = rendered.match(/\u0000error:(.+?)\u0000/);
  if (failed !== null) return { error: failed[1] };
  if (rendered.includes("{{")) return { error: "command contains a malformed placeholder" };
  return { command: rendered };
}
function recordFingerprint(record) {
  return JSON.stringify(record);
}

// src/index.ts
var name = "enpoi-custom-tools";
var inject = ["tools", "settings", "shell", "shellEnv"];
var Config = Schema.object({});
var DEFAULT_TIMEOUT_MS = 12e4;
var OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    command: { type: "string" },
    exitCode: { oneOf: [{ type: "number" }, { type: "null" }] },
    signal: { oneOf: [{ type: "string" }, { type: "null" }] },
    timedOut: { type: "boolean" },
    stdout: { type: "string" },
    stderr: { type: "string" },
    error: { type: "string" }
  }
};
function renderCustomToolResult(_args, value) {
  const run = value;
  const lines = [`custom tool: ${run.command}`];
  if (run.error !== "") lines.push(run.error);
  if (run.stdout !== "") lines.push(run.stdout.trimEnd());
  if (run.stderr !== "") lines.push(`[stderr]
${run.stderr.trimEnd()}`);
  if (run.timedOut) lines.push(`[timed out after ${String(DEFAULT_TIMEOUT_MS / 1e3)}s]`);
  if (run.exitCode !== null) lines.push(`[exit code: ${String(run.exitCode)}]`);
  else if (run.signal !== null) lines.push(`[killed by signal: ${run.signal}]`);
  return [{ type: "text", text: lines.join("\n") }];
}
function readCustomToolRecords(settings) {
  const document = readOrchestrationDocument(settings);
  const raw = document?.customTools;
  if (raw === void 0) return { records: [], errors: [] };
  if (!Array.isArray(raw)) return { records: [], errors: ["customTools must be an array"] };
  const records = [];
  const errors = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of raw) {
    const parsed = parseCustomToolRecord(entry);
    if (parsed.record === void 0) {
      errors.push(parsed.error ?? "invalid entry");
      continue;
    }
    if (seen.has(parsed.record.id)) {
      errors.push(`duplicate tool id "${parsed.record.id}"`);
      continue;
    }
    seen.add(parsed.record.id);
    records.push(parsed.record);
  }
  return { records, errors };
}
function apply(ctx, _config) {
  const registered = /* @__PURE__ */ new Map();
  const live = /* @__PURE__ */ new Map();
  let warned = "";
  const shell = () => ctx.get("shell");
  const register = (record) => {
    const executor = shell();
    if (executor === void 0) return;
    const parameters = {};
    for (const param of record.params) {
      const required = param.required ? { required: true } : {};
      parameters[param.name] = param.type === "string" ? { type: "string", ...required, description: param.description } : param.type === "number" ? { type: "number", ...required, description: param.description } : { type: "boolean", ...required, description: param.description };
    }
    const definition = defineTool({
      name: toolNameOf(record.id),
      description: record.description,
      parameters,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      output: {
        schema: OUTPUT_SCHEMA,
        render: renderCustomToolResult
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const rendered = renderCommand(record, args);
        if (rendered.command === void 0) {
          return { command: "", exitCode: null, signal: null, timedOut: false, stdout: "", stderr: "", error: `custom tool ${record.id}: ${rendered.error}` };
        }
        const value = {
          command: rendered.command,
          exitCode: null,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          error: ""
        };
        try {
          const policyService = executor.sandboxMode === void 0 ? void 0 : ctx.get("sandboxPolicy");
          const policy = policyService?.resolve(exec.agent === void 0 ? {} : { session: exec.agent.session });
          const dshEnv = ctx.get("shellEnv")?.collect(exec);
          const spec = executor.resolve({
            command: rendered.command,
            description: record.name,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            ...exec.signal === void 0 ? {} : { signal: exec.signal },
            ...policy === void 0 ? {} : { sandboxPolicy: policy },
            ...dshEnv === void 0 ? {} : { dshEnv }
          });
          const execution = await executor.execute(spec);
          const result = await execution.result();
          value.exitCode = result.exitCode;
          value.signal = result.signal;
          value.timedOut = result.timedOut;
          value.stdout = result.stdout.text;
          value.stderr = result.stderr.text;
        } catch (error) {
          value.error = `custom tool ${record.id} could not execute: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
        }
        return value;
      }
    });
    const dispose = ctx.tools.register(definition);
    registered.set(record.id, { dispose, fingerprint: recordFingerprint(record) });
  };
  const sync = () => {
    const { records, errors } = readCustomToolRecords(ctx.get("settings"));
    const errorLine = errors.join("; ");
    if (errorLine !== warned) {
      warned = errorLine;
      if (errorLine !== "") process.stderr.write(`[enpoi-custom-tools] skipped invalid records: ${errorLine}
`);
    }
    const next = new Map(records.map((record) => [record.id, record]));
    for (const [id, entry] of registered) {
      const record = next.get(id);
      if (record === void 0 || recordFingerprint(record) !== entry.fingerprint) {
        entry.dispose();
        registered.delete(id);
        live.delete(id);
      }
    }
    for (const record of records) {
      if (registered.has(record.id)) continue;
      try {
        register(record);
        live.set(record.id, record);
      } catch (error) {
        process.stderr.write(`[enpoi-custom-tools] could not register "${record.id}": ${error instanceof Error ? error.message : String(error)}
`);
      }
    }
  };
  ctx.provide("customToolCommands", {
    render(toolName, args) {
      const id = recordIdOf(toolName);
      if (id === void 0) return void 0;
      const record = live.get(id);
      if (record === void 0) return void 0;
      const rendered = renderCommand(record, args);
      return rendered.command === void 0 ? void 0 : { command: rendered.command };
    }
  });
  const onNamespaceChange = ((ns) => {
    if (String(ns) !== "enpoi-orchestration") return;
    sync();
  });
  ctx.on("settings/document-updated", onNamespaceChange);
  ctx.on("settings/updated", onNamespaceChange);
  ctx.effect(() => () => {
    for (const entry of registered.values()) entry.dispose();
    registered.clear();
    live.clear();
  }, "enpoi-custom-tools: registered tools");
  sync();
  process.stderr.write("[enpoi-custom-tools] mounted\n");
}
export {
  Config,
  DEFAULT_TIMEOUT_MS,
  apply,
  inject,
  name,
  readCustomToolRecords,
  renderCustomToolResult
};
