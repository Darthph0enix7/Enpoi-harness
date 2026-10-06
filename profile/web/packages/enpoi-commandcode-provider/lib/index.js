// src/index.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { PoolEngine } from "@deepseek-ai/dsh-llm-pi-ai";
import { deepEqualJson } from "@deepseek-ai/dsh-util-values";
import Schema from "@deepseek-ai/schemastery";

// src/catalog.ts
function parseCatalog(raw) {
  const rows = Array.isArray(raw) ? raw : Object.values(raw ?? {});
  const entries = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record = row;
    if (typeof record.id !== "string" || record.id === "") continue;
    entries.push({
      id: record.id,
      name: typeof record.name === "string" && record.name !== "" ? record.name : record.id,
      ...typeof record.tier === "string" ? { tier: record.tier } : {},
      ...typeof record.reasoning === "boolean" ? { reasoning: record.reasoning } : {},
      ...typeof record.tool_call === "boolean" ? { tool_call: record.tool_call } : {},
      ...typeof record.attachment === "boolean" ? { attachment: record.attachment } : {},
      ...typeof record.modalities === "object" && record.modalities !== null ? { modalities: record.modalities } : {},
      ...Array.isArray(record.reasoningEfforts) ? { reasoningEfforts: record.reasoningEfforts.filter((effort) => typeof effort === "string") } : {},
      ...typeof record.variants === "object" && record.variants !== null ? { variants: record.variants } : {},
      ...typeof record.cost === "object" && record.cost !== null ? { cost: record.cost } : {},
      ...typeof record.limit === "object" && record.limit !== null ? { limit: record.limit } : {}
    });
  }
  return entries;
}
function entryFor(entries, modelId) {
  const exact = entries.find((entry) => entry.id === modelId);
  if (exact !== void 0) return exact;
  const short = modelId.split("/").pop() ?? modelId;
  return entries.find((entry) => entry.id === short || entry.id.split("/").pop() === short);
}
function visionOf(entry) {
  if (entry === void 0) return true;
  if (entry.attachment === true) return true;
  const inputs = entry.modalities?.input;
  if (Array.isArray(inputs) && inputs.length > 0) return inputs.includes("image");
  return true;
}
function modalitiesOf(entry) {
  const inputs = entry?.modalities?.input;
  if (!Array.isArray(inputs) || inputs.length === 0) return void 0;
  return inputs.filter((modality) => modality === "text" || modality === "image");
}
function effortsOf(entry) {
  if (entry?.reasoning !== true) return [];
  return entry.reasoningEfforts ?? [];
}
function contextWindowOf(entry) {
  const context = entry?.limit?.context;
  return typeof context === "number" && context > 0 ? context : void 0;
}
function isLoopbackBaseURL(baseURL) {
  let host;
  try {
    host = new URL(baseURL).hostname;
  } catch (_invalidBaseURL) {
    return false;
  }
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare === "localhost" || bare === "::1") return true;
  const octets = bare.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}
var CatalogStore = class {
  constructor(options) {
    this.options = options;
  }
  pending;
  resolved;
  origin = "snapshot";
  /** Kick the live fetch; safe to call once per route. */
  start() {
    void this.load().catch(() => void 0);
  }
  /** The catalog entries, fetching once on first demand. */
  async entries() {
    return await this.load();
  }
  /** Which source served the current entries. */
  source() {
    return this.origin;
  }
  load() {
    if (this.resolved !== void 0) return Promise.resolve(this.resolved);
    this.pending ??= (isLoopbackBaseURL(this.options.baseURL) ? this.fetchLive().then((entries) => ({ entries, source: "live" })) : Promise.resolve({ entries: [...this.options.snapshot], source: "snapshot" })).then(({ entries, source }) => {
      this.resolved = entries;
      this.origin = source;
      return entries;
    }).catch(() => {
      this.resolved = [...this.options.snapshot];
      this.origin = "snapshot";
      return this.resolved;
    });
    return this.pending;
  }
  async fetchLive() {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const url = `${this.options.baseURL.replace(/\/+$/, "")}/catalog.json`;
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 5e3)
    });
    if (!response.ok) throw new Error(`catalog fetch failed: HTTP ${String(response.status)}`);
    const entries = parseCatalog(JSON.parse(await response.text()));
    if (entries.length === 0) throw new Error("catalog fetch returned no models");
    return entries;
  }
};

// src/adapter.ts
import { requestImageDimensions } from "@deepseek-ai/dsh-attachment";
import {
  attributionHeaders,
  CONTEXT_WINDOW_EXCEEDED_CODE as CONTEXT_WINDOW_EXCEEDED_CODE2,
  LlmAdapter,
  LlmError as LlmError2,
  QUOTA_EXCEEDED_CODE as QUOTA_EXCEEDED_CODE2
} from "@deepseek-ai/dsh-llm";
import { parseQuotaHeaders, ROTATING_CLASSES } from "@deepseek-ai/dsh-llm-pi-ai";

// src/sanitize.ts
var MAX_INLINE_TOOL_TEXT_CHARS = 2e5;
var EMBEDDED_B64_RE = /data:image\/[^;]{1,64};base64,[A-Za-z0-9+/=]{512,}/g;
var IMAGE_STRIP_NOTE = "[older image omitted: request exceeded the upstream payload limit]";
function sanitizeText(str) {
  let s = str;
  if (s.includes(";base64,")) {
    s = s.replace(EMBEDDED_B64_RE, (match) => {
      const kb = Math.max(1, Math.round(match.length * 0.75 / 1024));
      return `[embedded base64 payload omitted: ~${kb} KB]`;
    });
  }
  if (s.length > MAX_INLINE_TOOL_TEXT_CHARS) {
    const orig = s.length;
    s = s.slice(0, MAX_INLINE_TOOL_TEXT_CHARS) + `
... [output truncated: ${orig} chars exceed ${MAX_INLINE_TOOL_TEXT_CHARS} limit]`;
  }
  return s;
}
function isImagePart(part) {
  if (part === null || typeof part !== "object") return false;
  const record = part;
  if (record.type === "image" || record.type === "image_url") return true;
  if (record.type === "file" && String(record.mediaType ?? record.mimeType ?? "").startsWith("image/")) return true;
  return false;
}
function stripOlderImagesKeepingNewest(envelope) {
  const rawMessages = envelope.params.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) return 0;
  const messages = rawMessages;
  let kept = false;
  let removed = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === void 0 || message === null || message.role !== "user" || !Array.isArray(message.content)) continue;
    const content = message.content;
    for (let p = content.length - 1; p >= 0; p--) {
      if (!isImagePart(content[p])) continue;
      if (!kept) {
        kept = true;
        continue;
      }
      content[p] = { type: "text", text: IMAGE_STRIP_NOTE };
      removed += 1;
    }
  }
  return removed;
}

// src/convert.ts
var KEEP_TEXT = (text) => text;
var MAX_FORWARD_IMAGE_BYTES = 8 * 1024 * 1024;
var MAX_FORWARD_IMAGES_TOTAL = 12;
var MAX_FORWARD_IMAGE_BYTES_TOTAL = 16 * 1024 * 1024;
function createImageForwarder(enabled) {
  return { enabled, images: [], seen: /* @__PURE__ */ new Set(), bytes: 0 };
}
function resolvePartDataUri(part, resolveImage) {
  const payload = part.data ?? part.url ?? part.image;
  if (typeof payload === "string" && payload.startsWith("data:")) return payload;
  const resolved = resolveImage?.(part);
  if (resolved !== void 0 && resolved.startsWith("data:")) return resolved;
  if (payload === void 0) return void 0;
  return toDataUri(payload, detectMediaType(part));
}
function planUserImages(messages, resolveImage) {
  const candidates = [];
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (!isRecord(part) || typeof part.type !== "string") continue;
      if (part.type !== "file" && part.type !== "image" && part.type !== "media") continue;
      if (!detectMediaType(part).startsWith("image/")) continue;
      const dataUri = resolvePartDataUri(part, resolveImage);
      if (dataUri === void 0) continue;
      candidates.push({ part, dataUri });
    }
  }
  const plan = /* @__PURE__ */ new Map();
  let keptBytes = 0;
  let keptCount = 0;
  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index];
    if (candidate === void 0) continue;
    if (candidate.dataUri.length > MAX_FORWARD_IMAGE_BYTES || keptCount >= MAX_FORWARD_IMAGES_TOTAL || keptBytes + candidate.dataUri.length > MAX_FORWARD_IMAGE_BYTES_TOTAL) {
      plan.set(candidate.part, null);
      continue;
    }
    plan.set(candidate.part, candidate.dataUri);
    keptBytes += candidate.dataUri.length;
    keptCount += 1;
  }
  return plan;
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function dataUriMime(dataUri) {
  if (!dataUri.startsWith("data:")) return null;
  const semi = dataUri.indexOf(";");
  const comma = dataUri.indexOf(",");
  if (semi === -1 || comma === -1 || semi > comma) return null;
  return dataUri.slice(5, semi) || null;
}
function detectMediaType(part) {
  const declared = part.mediaType ?? part.mimeType ?? part.media_type;
  if (typeof declared === "string" && declared.trim() !== "") return declared.trim();
  const payload = part.data ?? part.url ?? part.image;
  if (typeof payload === "string") {
    const mime = dataUriMime(payload);
    if (mime !== null) return mime;
  }
  return "application/octet-stream";
}
function byteLengthOf(data) {
  if (typeof data === "string") return data.length;
  if (data instanceof Uint8Array) return data.byteLength;
  return 0;
}
function kilobytes(payloadLength) {
  return Math.max(1, Math.round(payloadLength / 1024));
}
function toDataUri(payload, mediaType) {
  if (typeof payload === "string") {
    if (payload.startsWith("data:")) return payload;
    return `data:${mediaType};base64,${payload}`;
  }
  if (payload instanceof Uint8Array) {
    return `data:${mediaType};base64,${Buffer.from(payload).toString("base64")}`;
  }
  return void 0;
}
function describeOmitted(part, mediaType, reason) {
  const bytes = byteLengthOf(part.data) || byteLengthOf(part.image) || byteLengthOf(part.url);
  const size = bytes > 0 ? `, ${kilobytes(bytes)} KB` : "";
  return `[image omitted: ${mediaType}${size} \u2014 ${reason}]`;
}
function describeBinaryPart(part) {
  const mediaType = detectMediaType(part);
  const bytes = byteLengthOf(part.data) || byteLengthOf(part.image) || byteLengthOf(part.url);
  const size = bytes > 0 ? `, ${kilobytes(bytes)} KB` : "";
  return `[attachment omitted: ${mediaType}${size} \u2014 binary payloads are not inlined into text]`;
}
function isBinaryLikePart(part) {
  if (part.type === "file" || part.type === "image" || part.type === "media") return true;
  if (typeof part.data === "string" && part.data.startsWith("data:")) return true;
  if (typeof part.url === "string" && part.url.startsWith("data:")) return true;
  return false;
}
function convertBinaryPart(part, parts, forwarder, resolveImage, plan) {
  const mediaType = detectMediaType(part);
  const payload = part.data ?? part.url ?? part.image;
  if (mediaType.startsWith("image/")) {
    if (!forwarder.enabled) {
      parts.push({ type: "text", text: describeOmitted(part, mediaType, "this model does not accept image input") });
      return false;
    }
    const planned = plan.get(part);
    if (planned === null) {
      parts.push({
        type: "text",
        text: describeOmitted(
          part,
          mediaType,
          "per-request image budget reached \u2014 older images are omitted and the newest are kept"
        )
      });
      return false;
    }
    if (planned !== void 0) {
      parts.push({ type: "image", image: planned, mimeType: mediaType });
      return true;
    }
    const resolved = typeof payload === "string" && payload.startsWith("data:") ? payload : resolveImage?.(part);
    const dataUri = resolved ?? (payload === void 0 ? void 0 : toDataUri(payload, mediaType));
    if (dataUri !== void 0 && dataUri.startsWith("data:")) {
      parts.push({ type: "image", image: dataUri, mimeType: mediaType });
      return true;
    }
    parts.push({
      type: "text",
      text: describeOmitted(
        part,
        mediaType,
        payload === void 0 ? "no payload present" : "the API accepts inline data URIs only, not remote URLs"
      )
    });
    return false;
  }
  if (mediaType.startsWith("text/") && typeof payload === "string" && !payload.startsWith("data:")) {
    parts.push({ type: "text", text: payload });
    return false;
  }
  parts.push({ type: "text", text: describeBinaryPart(part) });
  return false;
}
function convertUserContent(content, forwarder, resolveImage, plan, scrub) {
  if (typeof content === "string") return scrub(content);
  const parts = [];
  let hasMultimodal = false;
  for (const part of content) {
    if (!isRecord(part) || typeof part.type !== "string") continue;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "file" || part.type === "image" || part.type === "media") {
      if (convertBinaryPart(part, parts, forwarder, resolveImage, plan)) hasMultimodal = true;
      continue;
    }
    if (isBinaryLikePart(part)) parts.push({ type: "text", text: describeBinaryPart(part) });
  }
  if (!hasMultimodal) return scrub(parts.map((part) => part.type === "text" ? String(part.text) : "").join("\n"));
  return parts.map((part) => part.type === "text" && typeof part.text === "string" ? { ...part, text: scrub(part.text) } : part);
}
function imageFingerprint(dataUri) {
  return `${dataUri.length}:${dataUri.slice(0, 64)}:${dataUri.slice(-64)}`;
}
function handleBinaryPart(part, forwarder) {
  const mediaType = detectMediaType(part);
  const raw = part.data ?? part.image ?? part.url;
  if (!forwarder.enabled || !mediaType.startsWith("image/")) return describeBinaryPart(part);
  const dataUri = typeof raw === "string" && raw.startsWith("data:") ? raw : raw === void 0 ? void 0 : toDataUri(raw, mediaType);
  if (dataUri === void 0 || !dataUri.startsWith("data:")) return describeBinaryPart(part);
  if (dataUri.length > MAX_FORWARD_IMAGE_BYTES) {
    return `[image omitted: ${mediaType}, ${kilobytes(dataUri.length)} KB exceeds the ${Math.round(MAX_FORWARD_IMAGE_BYTES / 1024 / 1024)} MB per-image forward limit]`;
  }
  const fingerprint = imageFingerprint(dataUri);
  if (forwarder.seen.has(fingerprint)) {
    return `[identical ${mediaType} image already attached earlier in this conversation \u2014 not re-sent]`;
  }
  if (forwarder.images.length >= MAX_FORWARD_IMAGES_TOTAL || forwarder.bytes + dataUri.length > MAX_FORWARD_IMAGE_BYTES_TOTAL) {
    return `[image omitted: per-request image forward budget reached \u2014 ${forwarder.images.length} image(s), ${Math.round(forwarder.bytes / 1024 / 1024)} MB already forwarded]`;
  }
  forwarder.seen.add(fingerprint);
  forwarder.bytes += dataUri.length;
  forwarder.images.push({ mediaType, dataUri });
  return `[${mediaType} image, ${kilobytes(dataUri.length)} KB \u2014 attached as a user message below]`;
}
function toolResultText(part, forwarder) {
  if (part.type === "text" && typeof part.text === "string") return part.text;
  if (part.type === "file" || part.type === "image" || part.type === "media" || isBinaryLikePart(part)) {
    return handleBinaryPart(part, forwarder);
  }
  try {
    return JSON.stringify(part) ?? "";
  } catch {
    return "[unserializable tool output omitted]";
  }
}
function parseToolInput(argumentsJson) {
  try {
    return JSON.parse(argumentsJson);
  } catch {
    return argumentsJson;
  }
}
function toolNamesById(messages) {
  const names = /* @__PURE__ */ new Map();
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call" && typeof part.toolName === "string" && typeof part.toolCallId === "string") {
        names.set(part.toolCallId, part.toolName);
      }
    }
  }
  return names;
}
function buildRequest(input) {
  const scrub = input.sanitizeText === true ? sanitizeText : KEEP_TEXT;
  const forwarder = createImageForwarder(input.visionEnabled !== false);
  const userImagePlan = forwarder.enabled ? planUserImages(input.messages, input.resolveImage) : /* @__PURE__ */ new Map();
  const names = toolNamesById(input.messages);
  const messages = [];
  let system = input.system ?? "";
  for (const message of input.messages) {
    if (message.role === "system") {
      if (typeof message.content === "string") {
        system += (system === "" ? "" : "\n\n") + message.content;
      } else {
        const text = message.content.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => String(part.text)).join("\n\n");
        if (text !== "") system += (system === "" ? "" : "\n\n") + text;
      }
      continue;
    }
    if (message.role === "developer") continue;
    if (message.role === "user") {
      messages.push({
        role: "user",
        content: convertUserContent(message.content, forwarder, input.resolveImage, userImagePlan, scrub)
      });
      continue;
    }
    if (message.role === "assistant") {
      const parts = [];
      if (typeof message.content !== "string") {
        for (const part of message.content) {
          if (part.type === "text" && typeof part.text === "string") {
            parts.push({ type: "text", text: scrub(part.text) });
          } else if (part.type === "reasoning" && typeof part.text === "string") {
            parts.push({ type: "reasoning", text: scrub(part.text) });
          } else if (part.type === "tool-call") {
            parts.push({
              type: "tool-call",
              toolCallId: String(part.toolCallId ?? ""),
              toolName: String(part.toolName ?? ""),
              input: parseToolInput(String(part.arguments ?? "{}"))
            });
          }
        }
      }
      if (parts.length > 0) messages.push({ role: "assistant", content: parts });
      continue;
    }
    const results = [];
    const callId = message.toolCallId ?? "";
    const value = scrub(typeof message.content === "string" ? message.content : message.content.map((part) => toolResultText(part, forwarder)).join("\n"));
    results.push({
      type: "tool-result",
      toolCallId: callId,
      toolName: names.get(callId) ?? "unknown",
      output: message.isError === true ? { type: "error-text", value } : { type: "text", value }
    });
    messages.push({ role: "tool", content: results });
    if (forwarder.images.length > 0) {
      const pending = forwarder.images.splice(0, forwarder.images.length);
      messages.push({
        role: "user",
        content: [
          { type: "text", text: "Images returned by the tool call(s) above:" },
          ...pending.map((image) => ({ type: "image", image: image.dataUri, mimeType: image.mediaType }))
        ]
      });
    }
  }
  const params = {
    model: input.model,
    messages,
    tools: [...input.tools ?? []],
    system,
    max_tokens: input.maxTokens ?? 16384,
    stream: true,
    ...input.reasoningEffort === void 0 ? {} : { reasoning_effort: input.reasoningEffort },
    ...input.temperature === void 0 ? {} : { temperature: input.temperature }
  };
  const now = input.now ?? /* @__PURE__ */ new Date();
  return {
    config: {
      workingDir: input.workingDir ?? process.cwd(),
      date: now.toISOString().split("T")[0] ?? "",
      environment: `${process.platform}-${process.arch}`,
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: []
    },
    memory: "",
    taste: "",
    skills: null,
    permissionMode: "standard",
    params
  };
}

// src/errors.ts
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  QUOTA_EXCEEDED_CODE
} from "@deepseek-ai/dsh-llm";
function errorMessageFromBody(body) {
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed;
      const error = record.error;
      if (typeof error === "string") return error;
      if (typeof error === "object" && error !== null) {
        const message = error.message;
        if (typeof message === "string") return message;
      }
      if (typeof record.message === "string") return record.message;
      if (typeof record.detail === "string") return record.detail;
    }
  } catch {
  }
  return body.trim().slice(0, 600);
}
function classifyCommandCodeError(status, body) {
  const message = errorMessageFromBody(body);
  const detail = `${status} ${message}`;
  if (isContextWindowExceededError(detail) || /longer than the model.*context|context length/i.test(detail)) {
    return { code: CONTEXT_WINDOW_EXCEEDED_CODE, message };
  }
  if (isQuotaExceededError(detail) || /reached your weekly usage limit|usage limit|insufficient credits/i.test(detail)) {
    return { code: QUOTA_EXCEEDED_CODE, message };
  }
  if (/Proxy use detected/i.test(detail)) {
    return {
      code: "PROXY_USE_DETECTED",
      message: `${message} \u2014 the CLI-shaped endpoint was reached without the keypool (or its CLI headers) in front of it`
    };
  }
  if (status === 401 || status === 402 || status === 403) return { code: "AUTH", message };
  if (status === 429) return { code: "RATE_LIMIT", message };
  if (status >= 500) return { code: "SERVER", message };
  if (status === 0) return { code: "SERVER", message };
  return { code: "INVALID_REQUEST", message };
}

// src/headers.ts
var COMMAND_CODE_CLI_VERSION = "1.54.0";
var COMMAND_CODE_CLI_HEADERS = {
  "x-command-code-version": COMMAND_CODE_CLI_VERSION,
  "x-cli-environment": "production",
  "x-project-slug": "opencode",
  "user-agent": "cli"
};
function commandCodeHeaders(apiKey) {
  return {
    ...COMMAND_CODE_CLI_HEADERS,
    ...apiKey === void 0 || apiKey === "" ? {} : {
      authorization: `Bearer ${apiKey}`,
      "x-api-key": apiKey
    }
  };
}

// src/stream.ts
import { LlmError } from "@deepseek-ai/dsh-llm";
async function* rawEvents(source) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseLine(line);
      if (event !== void 0) yield event;
    }
  }
  const tail = parseLine(buffer);
  if (tail !== void 0) yield tail;
}
function parseLine(rawLine) {
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith(":") || trimmed === "[DONE]") return void 0;
  let json = trimmed;
  if (json.startsWith("data: ")) json = json.slice(6);
  else if (json.startsWith("data:")) json = json.slice(5);
  if (json === "" || json === "[DONE]") return void 0;
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return void 0;
  }
  if (typeof parsed !== "object" || parsed === null) return void 0;
  const event = parsed;
  if (typeof event.type !== "string") return void 0;
  return event;
}
function mapFinishReason(raw) {
  switch (raw) {
    case "stop":
    case "end_turn":
      return { kind: "stop" };
    case "tool_calls":
    case "tool-calls":
      return { kind: "tool-calls" };
    case "length":
    case "max_tokens":
    case "max-tokens":
    case "max_output_tokens":
      return { kind: "max-tokens" };
    default:
      return { kind: "stop" };
  }
}
function numberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function mapUsage(raw) {
  const inputDetails = raw.inputTokenDetails ?? raw.input_token_details ?? {};
  const outputDetails = raw.outputTokenDetails ?? raw.output_token_details ?? {};
  const totalInput = numberOrUndefined(raw.inputTokens) ?? numberOrUndefined(raw.prompt_tokens);
  const totalOutput = numberOrUndefined(raw.outputTokens) ?? numberOrUndefined(raw.completion_tokens);
  const cacheReadTokens = numberOrUndefined(inputDetails.cacheReadTokens) ?? numberOrUndefined(inputDetails.cache_read_tokens);
  const cacheWriteTokens = numberOrUndefined(inputDetails.cacheWriteTokens) ?? numberOrUndefined(inputDetails.cache_write_tokens);
  const noCacheInput = numberOrUndefined(inputDetails.noCacheTokens) ?? numberOrUndefined(inputDetails.no_cache_tokens) ?? (totalInput === void 0 ? void 0 : Math.max(0, totalInput - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0)));
  const reasoningTokens = numberOrUndefined(outputDetails.reasoningTokens) ?? numberOrUndefined(outputDetails.reasoning_tokens);
  return {
    inputTokens: noCacheInput ?? 0,
    outputTokens: totalOutput ?? 0,
    ...totalInput === void 0 || totalOutput === void 0 ? {} : { totalTokens: totalInput + totalOutput },
    ...cacheReadTokens === void 0 ? {} : { cacheReadTokens },
    ...cacheWriteTokens === void 0 ? {} : { cacheWriteTokens },
    ...reasoningTokens === void 0 ? {} : { reasoningTokens }
  };
}
function asAsyncIterable(source) {
  const candidate = source;
  if (typeof candidate[Symbol.asyncIterator] === "function") return candidate;
  const reader = source.getReader();
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return reader.read();
        },
        async return() {
          await reader.cancel();
          return { done: true, value: void 0 };
        }
      };
    }
  };
}
async function* parseCommandCodeStream(source) {
  const blocks = /* @__PURE__ */ new Map();
  let nextIndex = 0;
  let metadataId;
  let metadataModel;
  const open = (key, kind, id, toolName) => {
    const existing = blocks.get(key);
    if (existing !== void 0) {
      if (toolName !== void 0 && existing.toolName === void 0) existing.toolName = toolName;
      return { block: existing, opened: false };
    }
    const block = { kind, index: nextIndex++, id, toolName, text: "", args: "" };
    blocks.set(key, block);
    return { block, opened: true };
  };
  function* closeBlock(block) {
    switch (block.kind) {
      case "text":
        yield { type: "block-end", index: block.index, block: { type: "text", text: block.text } };
        return;
      case "reasoning":
        yield { type: "block-end", index: block.index, block: { type: "reasoning", text: block.text } };
        return;
      case "tool":
        yield {
          type: "block-end",
          index: block.index,
          block: {
            type: "tool-call",
            id: block.id,
            name: block.toolName ?? "",
            arguments: block.args
          }
        };
        return;
      /* v8 ignore next 2 -- closed union */
      default:
        return;
    }
  }
  for await (const event of rawEvents(asAsyncIterable(source))) {
    switch (event.type) {
      case "text-start":
      case "text-delta":
      case "text-end": {
        const key = typeof event.id === "string" ? `text:${event.id}` : "text:__default";
        const { block, opened } = open(key, "text", key);
        if (opened) yield { type: "block-start", index: block.index, blockType: "text" };
        const delta = event.type === "text-delta" ? String(event.text ?? event.delta ?? "") : "";
        if (delta !== "") {
          block.text += delta;
          yield { type: "text-delta", index: block.index, text: delta };
        }
        if (event.type === "text-end") {
          blocks.delete(key);
          yield* closeBlock(block);
        }
        continue;
      }
      case "reasoning-start":
      case "reasoning-delta":
      case "reasoning-end": {
        const key = typeof event.id === "string" ? `reasoning:${event.id}` : "reasoning:__default";
        const { block, opened } = open(key, "reasoning", key);
        if (opened) yield { type: "block-start", index: block.index, blockType: "reasoning" };
        const delta = event.type === "reasoning-delta" ? String(event.text ?? event.delta ?? "") : "";
        if (delta !== "") {
          block.text += delta;
          yield { type: "reasoning-delta", index: block.index, text: delta };
        }
        if (event.type === "reasoning-end") {
          blocks.delete(key);
          yield* closeBlock(block);
        }
        continue;
      }
      case "tool-input-start": {
        const callId = typeof event.id === "string" ? event.id : "";
        const key = `tool:${callId}`;
        const { block, opened } = open(key, "tool", callId, typeof event.toolName === "string" ? event.toolName : void 0);
        if (opened) yield { type: "block-start", index: block.index, blockType: "tool-call" };
        continue;
      }
      case "tool-input-delta": {
        const callId = typeof event.id === "string" ? event.id : "";
        const key = `tool:${callId}`;
        const { block, opened } = open(key, "tool", callId);
        if (opened) yield { type: "block-start", index: block.index, blockType: "tool-call" };
        const delta = String(event.delta ?? "");
        block.args += delta;
        yield {
          type: "tool-call-delta",
          index: block.index,
          id: block.id,
          ...block.toolName === void 0 ? {} : { name: block.toolName },
          argumentsDelta: delta
        };
        continue;
      }
      case "tool-input-end":
        continue;
      case "tool-call": {
        const callId = String(event.toolCallId ?? event.id ?? "");
        const key = `tool:${callId}`;
        const { block, opened } = open(key, "tool", callId, typeof event.toolName === "string" ? event.toolName : void 0);
        if (opened) yield { type: "block-start", index: block.index, blockType: "tool-call" };
        const input = event.input ?? event.args ?? event.arguments;
        block.args = typeof input === "string" ? input : JSON.stringify(input ?? {});
        blocks.delete(key);
        yield* closeBlock(block);
        continue;
      }
      case "response-metadata": {
        if (typeof event.id === "string") metadataId = event.id;
        if (typeof event.modelId === "string") metadataModel = event.modelId;
        continue;
      }
      case "finish-step": {
        for (const [key, block] of [...blocks.entries()]) {
          blocks.delete(key);
          yield* closeBlock(block);
        }
        const usage = event.usage ?? event.totalUsage;
        yield {
          type: "usage",
          usage: mapUsage(typeof usage === "object" && usage !== null ? usage : {})
        };
        const rawReason = String(event.finishReason ?? event.rawFinishReason ?? "stop");
        yield {
          type: "finish",
          reason: rawReason === "error" ? { kind: "error", failure: { message: "Command Code reported a step error", code: "SERVER" } } : mapFinishReason(rawReason),
          ...metadataId === void 0 && metadataModel === void 0 ? {} : { replayState: { response: { id: metadataId, modelId: metadataModel } } }
        };
        return;
      }
      case "error": {
        const detail = typeof event.error === "string" ? event.error : typeof event.message === "string" ? event.message : JSON.stringify(event.error ?? event);
        throw new LlmError(`Command Code stream error: ${detail}`, classifyCommandCodeError(0, detail).code);
      }
      default:
        continue;
    }
  }
  throw new LlmError("Command Code stream ended without a finish-step event", "STREAM_CLOSED");
}

// src/adapter.ts
var DEFAULT_USER_IMAGE_MAX_PIXELS = 2048 * 2048;
var DEFAULT_USER_IMAGE_MAX_BYTES = 1024 * 1024;
var REQUEST_TIMEOUT_MS = 3e5;
var DEFAULT_POOL_MAX_ATTEMPTS = 5;
var DEFAULT_POOL_DEADLINE_MS = 3e4;
function poolFailureClassOf(code, status) {
  if (code === CONTEXT_WINDOW_EXCEEDED_CODE2 || code === "INVALID_REQUEST") return "INVALID_REQUEST";
  if (code === QUOTA_EXCEEDED_CODE2 || code === "RATE_LIMIT") return "QUOTA";
  if (code === "AUTH") return "AUTH";
  if (code === "PROXY_USE_DETECTED") return "POLICY";
  if (code === "SERVER") return status === 503 || status === 529 ? "CAPACITY" : "UPSTREAM";
  return "UPSTREAM";
}
function toCcTools(tools) {
  return (tools ?? []).map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters
  }));
}
function userImageTarget(ref, budget) {
  return { ...requestImageDimensions(ref.width, ref.height, budget.maxPixels), maxBytes: budget.maxBytes };
}
async function toCcMessages(options, readImage, readUserImage, userImageBudget) {
  const messages = [];
  for (const message of options.messages) {
    if (message.role === "system" || message.role === "developer") continue;
    if (message.role === "user") {
      const parts2 = [];
      for (const block of message.content) {
        switch (block.type) {
          case "text":
            parts2.push({ type: "text", text: block.text });
            break;
          case "image": {
            if (block.offloaded === true) {
              parts2.push({ type: "text", text: "[image omitted to fit request image limits]" });
              break;
            }
            const resolved = readUserImage === void 0 || userImageBudget === void 0 ? await readImage?.(block.attachment, options.signal) : await readUserImage(block.attachment, userImageTarget(block.attachment, userImageBudget), options.signal);
            if (resolved === void 0) {
              parts2.push({
                type: "text",
                text: `[image omitted: ${block.attachment.mediaType} \u2014 the attachment service could not read it]`
              });
              break;
            }
            parts2.push({
              type: "file",
              mediaType: resolved.mediaType,
              data: `data:${resolved.mediaType};base64,${Buffer.from(resolved.data).toString("base64")}`
            });
            break;
          }
          case "file":
            parts2.push({ type: "text", text: `[file attachment: ${block.attachment.name ?? "unnamed"}]` });
            break;
          default:
            break;
        }
      }
      messages.push({ role: "user", content: parts2 });
      continue;
    }
    if (message.role === "assistant") {
      const parts2 = [];
      for (const block of message.content) {
        if (block.type === "text") parts2.push({ type: "text", text: block.text });
        else if (block.type === "reasoning") parts2.push({ type: "reasoning", text: block.text });
        else if (block.type === "tool-call") {
          parts2.push({ type: "tool-call", toolCallId: block.id, toolName: block.name, arguments: block.arguments });
        }
      }
      if (parts2.length > 0) messages.push({ role: "assistant", content: parts2 });
      continue;
    }
    const parts = [];
    for (const block of message.content) {
      if (block.type === "text") parts.push({ type: "text", text: block.text });
      else if (block.type === "image") {
        if (block.offloaded === true) {
          parts.push({ type: "text", text: "[image omitted to fit request image limits]" });
          continue;
        }
        const resolved = readImage === void 0 ? void 0 : await readImage(block.attachment, options.signal);
        if (resolved === void 0) {
          parts.push({
            type: "text",
            text: `[image omitted: ${block.attachment.mediaType} \u2014 the attachment service could not read it]`
          });
          continue;
        }
        parts.push({
          type: "file",
          mediaType: resolved.mediaType,
          data: `data:${resolved.mediaType};base64,${Buffer.from(resolved.data).toString("base64")}`
        });
      }
    }
    messages.push({ role: "tool", content: parts, toolCallId: message.toolCallId, isError: message.isError === true });
  }
  return messages;
}
var CommandCodeAdapter = class extends LlmAdapter {
  constructor(options) {
    super();
    this.options = options;
  }
  profileOf(provider) {
    const profile = this.options.profiles().get(provider);
    if (profile === void 0) throw new LlmError2(`Command Code adapter does not own provider "${provider}"`, "NO_ADAPTER");
    return profile;
  }
  providerInfo(provider) {
    return { id: provider, name: this.options.profiles().get(provider)?.displayName ?? provider };
  }
  async listModels(provider) {
    const profile = this.profileOf(provider);
    const entries = await this.options.catalogFor(profile).entries();
    if (entries.length > 0) {
      return entries.map((entry) => ({
        provider,
        id: entry.id,
        name: entry.name,
        ...modalitiesOf(entry) === void 0 ? {} : { inputModalities: modalitiesOf(entry) }
      }));
    }
    return (profile.models ?? []).map((model) => ({
      provider,
      id: model.id,
      name: model.name ?? model.id
    }));
  }
  async resolveModel(provider, model, _signal) {
    const profile = this.profileOf(provider);
    const entries = await this.options.catalogFor(profile).entries();
    const entry = entryFor(entries, model);
    const efforts = effortsOf(entry);
    const context = contextWindowOf(entry);
    return {
      provider,
      id: model,
      name: entry?.name ?? model,
      ...modalitiesOf(entry) === void 0 ? {} : { inputModalities: modalitiesOf(entry) },
      ...context === void 0 ? {} : { context: { contextWindow: context } },
      ...efforts.length === 0 ? {} : {
        reasoning: {
          efforts: efforts.map((effort) => ({ id: effort, name: effort }))
        }
      }
    };
  }
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options)
    };
  }
  async *stream(options) {
    const profile = this.profileOf(options.provider);
    const catalog = this.options.catalogFor(profile);
    const entries = await catalog.entries();
    const entry = entryFor(entries, options.model);
    const effort = options.reasoningEffort;
    if (effort !== void 0) {
      const supported = effortsOf(entry);
      if (supported.length > 0 && !supported.includes(effort)) {
        throw new LlmError2(
          `Command Code model "${options.model}" does not support reasoning effort "${effort}" (catalog offers: ${supported.join(", ")})`,
          "UNSUPPORTED_REASONING_EFFORT"
        );
      }
    }
    const pooled = profile.pool !== void 0 && profile.pool.identities.length > 0;
    const key = pooled || profile.keyless ? void 0 : await this.options.resolveApiKey(profile);
    if (!pooled && !profile.keyless && key === void 0) {
      throw new LlmError2(
        `Command Code route "${options.provider}" resolves ${profile.apiKeyEnv ?? "no credential"}, which is not set`,
        "MISSING_CREDENTIAL"
      );
    }
    const messages = await toCcMessages(options, this.options.readImage, this.options.readUserImage, {
      maxPixels: profile.userImageMaxPixels,
      maxBytes: profile.userImageMaxBytes
    });
    const envelope = buildRequest({
      model: options.model,
      messages,
      // The default keypool route is fronted by the standalone proxy, which
      // owns text sanitization; a pooled route talks to the vendor directly,
      // so the conversion seam sanitizes its text (scrub + 200k cap) once.
      sanitizeText: pooled,
      tools: toCcTools(options.tools),
      ...options.system === void 0 ? {} : { system: options.system },
      ...options.maxTokens === void 0 ? {} : { maxTokens: options.maxTokens },
      ...options.temperature === void 0 ? {} : { temperature: options.temperature },
      ...effort === void 0 ? {} : { reasoningEffort: effort },
      visionEnabled: visionOf(entry),
      ...this.options.now === void 0 ? {} : { now: this.options.now() }
    });
    if (pooled) {
      yield* this.#streamPooled(options, profile, envelope);
      return;
    }
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = options.signal === void 0 ? timeout : AbortSignal.any([options.signal, timeout]);
    let response;
    try {
      response = await fetchImpl(`${profile.baseURL.replace(/\/+$/, "")}/alpha/generate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...attributionHeaders(),
          ...key === void 0 ? {} : { authorization: `Bearer ${key}` }
        },
        body: JSON.stringify(envelope),
        signal
      });
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw new LlmError2("Command Code request aborted by caller", "ABORTED", { cause: error });
      }
      throw new LlmError2(
        `Command Code transport failure: ${error instanceof Error ? error.message : String(error)}`,
        "TRANSPORT",
        { cause: error }
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const failure = classifyCommandCodeError(response.status, body);
      throw new LlmError2(`Command Code API error (${String(response.status)}): ${failure.message}`, failure.code);
    }
    if (response.body === null) {
      throw new LlmError2("Command Code API returned no response body", "SERVER");
    }
    yield* parseCommandCodeStream(response.body);
  }
  /**
   * The opt-in pooled path: resolve one credential per identity, order them
   * through the shared pool engine, inject the Command Code CLI headers and
   * that identity's auth (the converted envelope is already text-sanitized and
   * image-budgeted), and rotate across identities until one commits. A 413 is
   * retried once on the same identity with older images stripped; after the
   * first content delta the request is committed and failures surface
   * unchanged.
   */
  async *#streamPooled(options, profile, envelope) {
    const poolConfig = profile.pool;
    const engine = this.options.pool;
    if (poolConfig === void 0 || poolConfig.identities.length === 0) {
      throw new LlmError2(`Command Code route "${options.provider}" declares no pool identities`, "MISSING_CREDENTIAL");
    }
    if (engine === void 0) {
      throw new LlmError2(
        `Command Code route "${options.provider}" declares a credential pool but this adapter has no pool engine`,
        "MISSING_CREDENTIAL"
      );
    }
    const resolveCredential = this.options.resolveCredential;
    if (resolveCredential === void 0) {
      throw new LlmError2(
        `Command Code route "${options.provider}" declares a credential pool but this adapter has no credential resolver`,
        "MISSING_CREDENTIAL"
      );
    }
    await engine.hydrate(options.provider);
    const order = engine.orderFor(options.provider, poolConfig.identities, options.model, poolConfig.strategy);
    if (order.length === 0) {
      throw new LlmError2(
        `Command Code route "${options.provider}" has no enabled key-pool identity; enable one on the Models page (Keys card) and retry`,
        "MISSING_CREDENTIAL"
      );
    }
    const identityById = new Map(poolConfig.identities.map((identity) => [identity.id, identity]));
    const resolvedKeys = /* @__PURE__ */ new Map();
    for (const candidate of order) {
      const identity = identityById.get(candidate.id);
      if (identity === void 0) continue;
      const credential = await resolveCredential(identity.credentialRef);
      if (credential !== void 0 && credential.length > 0) {
        resolvedKeys.set(candidate.id, credential);
      } else {
        this.options.log?.(
          `commandcode-provider: pool identity "${identity.id}" names ${identity.credentialRef}, which resolves to nothing; skipping it`
        );
      }
    }
    const resolvableOrder = order.filter((candidate) => resolvedKeys.has(candidate.id));
    if (resolvableOrder.length === 0) {
      const refs = poolConfig.identities.map((identity) => identity.credentialRef).join(", ");
      throw new LlmError2(
        `Command Code route "${options.provider}" needs a credential, but none of its key-pool references (${refs}) resolve; store one on the Models page (Keys card) or export it, then retry`,
        "MISSING_CREDENTIAL"
      );
    }
    let body = JSON.stringify(envelope);
    let strippedOlderImages = false;
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const maxAttempts = Math.min(resolvableOrder.length, this.options.poolMaxAttempts ?? DEFAULT_POOL_MAX_ATTEMPTS);
    const deadline = Date.now() + (this.options.poolDeadlineMs ?? DEFAULT_POOL_DEADLINE_MS);
    let attempts = 0;
    let lastFailure = "no identity was attempted";
    for (const candidate of resolvableOrder) {
      if (attempts >= maxAttempts || Date.now() > deadline) break;
      if (options.signal?.aborted === true) {
        throw new LlmError2("Command Code request aborted by caller", "ABORTED");
      }
      const identity = identityById.get(candidate.id);
      if (identity === void 0) continue;
      attempts += 1;
      const apiKey = resolvedKeys.get(identity.id);
      const attemptController = new AbortController();
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal = options.signal === void 0 ? AbortSignal.any([attemptController.signal, timeout]) : AbortSignal.any([options.signal, attemptController.signal, timeout]);
      const send = () => fetchImpl(`${profile.baseURL.replace(/\/+$/, "")}/alpha/generate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          // Precedence contract: attribution carries only `user-agent`
          // (DeepSeek-Harness/...), the vendor gate serves `user-agent: cli`.
          // The CLI set is spread last so it always wins, including the
          // user-agent override; reversing the spreads would silently trip
          // the gate.
          ...attributionHeaders(),
          ...commandCodeHeaders(apiKey)
        },
        body,
        signal
      });
      let response;
      let transportError;
      try {
        response = await send();
      } catch (error) {
        transportError = error;
      }
      if (response !== void 0 && response.status === 413 && !strippedOlderImages) {
        const removed = stripOlderImagesKeepingNewest(envelope);
        if (removed > 0) {
          strippedOlderImages = true;
          body = JSON.stringify(envelope);
          this.options.log?.(
            `commandcode-provider: identity "${identity.id}" answered 413; stripped ${removed} older image(s) and retrying the same identity`
          );
          try {
            response = await send();
          } catch (error) {
            response = void 0;
            transportError = error;
          }
        }
      }
      if (response === void 0) {
        if (options.signal?.aborted) {
          throw new LlmError2("Command Code request aborted by caller", "ABORTED", { cause: transportError });
        }
        const message = `Command Code transport failure: ${transportError instanceof Error ? transportError.message : String(transportError)}`;
        engine.recordFailure(options.provider, identity.id, options.model, "UPSTREAM", message);
        lastFailure = message;
        attemptController.abort("commandcode pool rotated to the next identity");
        this.options.log?.(`commandcode-provider: identity "${identity.id}" failed (UPSTREAM); rotating`);
        continue;
      }
      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        const failure = classifyCommandCodeError(response.status, errorBody);
        if (response.status === 413 || failure.code === CONTEXT_WINDOW_EXCEEDED_CODE2 || failure.code === "INVALID_REQUEST") {
          throw new LlmError2(`Command Code API error (${String(response.status)}): ${failure.message}`, failure.code);
        }
        const failureClass2 = poolFailureClassOf(failure.code, response.status);
        engine.recordFailure(options.provider, identity.id, options.model, failureClass2, failure.message, response.status);
        lastFailure = failure.message;
        if (!ROTATING_CLASSES.has(failureClass2)) {
          throw new LlmError2(
            `Command Code route "${options.provider}" request failed without failover (${failureClass2}): ${failure.message}`,
            failure.code
          );
        }
        attemptController.abort("commandcode pool rotated to the next identity");
        this.options.log?.(`commandcode-provider: identity "${identity.id}" failed (${failureClass2}); rotating`);
        continue;
      }
      const quota = parseQuotaHeaders(response.headers);
      if (quota !== void 0) engine.recordQuota(options.provider, identity.id, options.model, quota);
      if (response.body === null) {
        engine.recordFailure(options.provider, identity.id, options.model, "UPSTREAM", "the response carried no body");
        lastFailure = "the response carried no body";
        attemptController.abort("commandcode pool rotated to the next identity");
        continue;
      }
      const iterator = parseCommandCodeStream(response.body)[Symbol.asyncIterator]();
      const buffered = [];
      let committed = false;
      let midFailure;
      try {
        for (; ; ) {
          const result = await iterator.next();
          if (result.done === true) break;
          const chunk = result.value;
          if (!committed) {
            if (chunk.type === "usage") {
              buffered.push(chunk);
              continue;
            }
            if (chunk.type === "finish" && chunk.reason.kind === "error") {
              midFailure = {
                code: chunk.reason.failure.code,
                message: chunk.reason.failure.message,
                ...chunk.reason.failure.status === void 0 ? {} : { status: chunk.reason.failure.status }
              };
              break;
            }
            committed = true;
            engine.recordSuccess(options.provider, identity.id, options.model);
            for (const held of buffered) yield held;
            buffered.length = 0;
          }
          if (chunk.type === "finish" && chunk.reason.kind === "error") {
            engine.recordFailure(
              options.provider,
              identity.id,
              options.model,
              poolFailureClassOf(chunk.reason.failure.code, chunk.reason.failure.status),
              chunk.reason.failure.message
            );
            yield chunk;
            break;
          }
          yield chunk;
        }
      } catch (error) {
        if (options.signal?.aborted) {
          throw new LlmError2("Command Code request aborted by caller", "ABORTED", { cause: error });
        }
        if (committed) {
          if (error instanceof LlmError2) {
            engine.recordFailure(
              options.provider,
              identity.id,
              options.model,
              poolFailureClassOf(error.code),
              error.message
            );
          }
          throw error;
        }
        midFailure = error instanceof LlmError2 ? { code: error.code, message: error.message } : { code: "STREAM_CLOSED", message: error instanceof Error ? error.message : String(error) };
      } finally {
        try {
          await iterator.return(void 0);
        } catch (_abortedStreamTeardown) {
        }
      }
      if (committed) return;
      if (midFailure === void 0) {
        midFailure = { code: "STREAM_CLOSED", message: "the attempt ended without content" };
      }
      const failureClass = poolFailureClassOf(midFailure.code, midFailure.status);
      engine.recordFailure(
        options.provider,
        identity.id,
        options.model,
        failureClass,
        midFailure.message,
        midFailure.status
      );
      lastFailure = midFailure.message;
      if (!ROTATING_CLASSES.has(failureClass)) {
        throw new LlmError2(
          `Command Code route "${options.provider}" request failed without failover (${failureClass}): ${midFailure.message}`,
          midFailure.code
        );
      }
      attemptController.abort("commandcode pool rotated to the next identity");
      this.options.log?.(`commandcode-provider: identity "${identity.id}" failed (${failureClass}); rotating`);
    }
    throw new LlmError2(
      `Command Code credential pool exhausted after ${attempts} attempt(s): ${lastFailure}`,
      "PROVIDER_POOL_EXHAUSTED"
    );
  }
};

// src/index.ts
var name = "commandcode-provider";
var inject = ["llm"];
var DEFAULT_SETTINGS_NS = "commandcode-provider";
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
var poolIdentitySchema = Schema.object({
  id: Schema.string().required(),
  credentialRef: Schema.string().required(),
  priority: Schema.natural(),
  enabled: Schema.boolean().default(true)
});
var routeProfileSchema = Schema.object({
  displayName: Schema.string(),
  api: Schema.string(),
  baseURL: Schema.string(),
  apiKeyEnv: Schema.string(),
  keyless: Schema.boolean(),
  models: Schema.array(Schema.object({ id: Schema.string().required(), name: Schema.string() })),
  userImageMaxPixels: Schema.natural(),
  userImageMaxBytes: Schema.natural(),
  // `.default(undefined)` is load-bearing: without it the nested object
  // materializes as `{}` for a route that declares no pool, and schemastery
  // then rejects the absent `identities` — failing every keypool route at
  // load. An explicit `pool: {}` still fails loud, as it should.
  pool: Schema.object({
    strategy: Schema.union(["priority-sticky", "balanced"]),
    identities: Schema.array(poolIdentitySchema).required()
  }).default(void 0)
});
var Config = Schema.object({
  providers: live(Schema.dict(routeProfileSchema).default({}))
});
function loadSnapshot() {
  try {
    const path = fileURLToPath(new URL("../catalog.snapshot.json", import.meta.url));
    return parseCatalog(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return [];
  }
}
function parsePoolConfig(route, raw) {
  if (raw === void 0) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`commandcode-provider: provider "${route}" pool must be an object`);
  }
  const record = raw;
  const strategy = record.strategy;
  if (strategy !== void 0 && strategy !== "priority-sticky" && strategy !== "balanced") {
    throw new Error(`commandcode-provider: provider "${route}" pool.strategy must be "priority-sticky" or "balanced"`);
  }
  const identitiesRaw = record.identities;
  if (!Array.isArray(identitiesRaw) || identitiesRaw.length === 0) {
    throw new Error(`commandcode-provider: provider "${route}" pool.identities must be a non-empty array`);
  }
  const identities = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of identitiesRaw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`commandcode-provider: provider "${route}" pool identity must be an object`);
    }
    const identity = entry;
    if (typeof identity.id !== "string" || identity.id === "") {
      throw new Error(`commandcode-provider: provider "${route}" pool identity needs a non-empty id`);
    }
    if (seen.has(identity.id)) {
      throw new Error(`commandcode-provider: provider "${route}" pool identity id "${identity.id}" is duplicated`);
    }
    seen.add(identity.id);
    if (typeof identity.credentialRef !== "string" || identity.credentialRef === "") {
      throw new Error(
        `commandcode-provider: provider "${route}" pool identity "${identity.id}" needs a non-empty credentialRef`
      );
    }
    const priority = identity.priority;
    if (priority !== void 0 && (typeof priority !== "number" || !Number.isSafeInteger(priority) || priority < 0)) {
      throw new Error(
        `commandcode-provider: provider "${route}" pool identity "${identity.id}" priority must be a non-negative integer`
      );
    }
    const enabled = identity.enabled;
    if (enabled !== void 0 && typeof enabled !== "boolean") {
      throw new Error(`commandcode-provider: provider "${route}" pool identity "${identity.id}" enabled must be a boolean`);
    }
    identities.push({
      id: identity.id,
      credentialRef: identity.credentialRef,
      ...typeof priority === "number" ? { priority } : {},
      ...typeof enabled === "boolean" ? { enabled } : {}
    });
  }
  return { pool: { ...strategy === void 0 ? {} : { strategy }, identities } };
}
function routeFromConfig(route, raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`commandcode-provider: provider "${route}" must be an object`);
  }
  const record = raw;
  const baseURL = record.baseURL;
  if (typeof baseURL !== "string" || baseURL.trim() === "") {
    throw new Error(`commandcode-provider: provider "${route}" needs a non-empty baseURL`);
  }
  const models = Array.isArray(record.models) ? record.models.flatMap((model) => {
    if (typeof model !== "object" || model === null) return [];
    const entry = model;
    if (typeof entry.id !== "string" || entry.id === "") return [];
    return [typeof entry.name === "string" ? { id: entry.id, name: entry.name } : { id: entry.id }];
  }) : [];
  const positiveInteger = (value, field, fallback) => {
    if (value === void 0) return fallback;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`commandcode-provider: provider "${route}" ${field} must be a positive integer`);
    }
    return value;
  };
  return {
    route,
    displayName: typeof record.displayName === "string" && record.displayName !== "" ? record.displayName : route,
    baseURL,
    ...typeof record.apiKeyEnv === "string" && record.apiKeyEnv !== "" ? { apiKeyEnv: record.apiKeyEnv } : {},
    keyless: record.keyless === true || record.apiKeyEnv === void 0 && record.key === void 0,
    models,
    userImageMaxPixels: positiveInteger(record.userImageMaxPixels, "userImageMaxPixels", DEFAULT_USER_IMAGE_MAX_PIXELS),
    userImageMaxBytes: positiveInteger(record.userImageMaxBytes, "userImageMaxBytes", DEFAULT_USER_IMAGE_MAX_BYTES),
    ...parsePoolConfig(route, record.pool)
  };
}
function providersOf(source) {
  if (typeof source !== "object" || source === null) return void 0;
  return plainConfig(source).providers;
}
function parseProfiles(providers) {
  const profiles = /* @__PURE__ */ new Map();
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) return profiles;
  for (const [route, raw] of Object.entries(providers)) profiles.set(route, routeFromConfig(route, raw));
  return profiles;
}
function apply(ctx, config = {}) {
  const settingsNs = ctx.fiber.entry?.options.id ?? DEFAULT_SETTINGS_NS;
  const snapshot = loadSnapshot();
  let lastRaw;
  let memoized;
  const profiles = () => {
    const raw = providersOf(config);
    if (memoized !== void 0 && raw === lastRaw) return memoized;
    const next = parseProfiles(raw);
    lastRaw = raw;
    memoized = next;
    return next;
  };
  for (const [route, profile] of profiles()) {
    const posture = profile.pool === void 0 ? profile.keyless ? "keyless/keypool" : "byok" : `native pool \xD7${String(profile.pool.identities.length)}`;
    ctx.logger.info(`commandcode-provider: route "${route}" \u2192 ${profile.baseURL} (${posture})`);
  }
  const catalogs = /* @__PURE__ */ new Map();
  const catalogFor = (profile) => {
    const cached = catalogs.get(profile.route);
    if (cached !== void 0 && cached.baseURL === profile.baseURL) return cached.store;
    const store = new CatalogStore({ baseURL: profile.baseURL, snapshot });
    catalogs.set(profile.route, { baseURL: profile.baseURL, store });
    store.start();
    return store;
  };
  const resolveApiKey = async (profile) => {
    if (profile.keyless || profile.apiKeyEnv === void 0) return void 0;
    const credentials = ctx.get("credentials");
    if (credentials === void 0) return void 0;
    const hit = await credentials.resolve(profile.apiKeyEnv);
    return hit?.value;
  };
  const launchEnv = launchEnvironmentOf(ctx);
  const poolEngine = new PoolEngine({
    stateDir: join(launchEnv.get("DSH_HOME")?.value ?? join(homedir(), ".dsh"), "pools"),
    log: (message) => ctx.logger.warn(message)
  });
  const resolveCredential = async (reference) => {
    const credentials = ctx.get("credentials");
    const hit = credentials !== void 0 ? (await credentials.resolve(credentialRef(reference)))?.value : launchEnv.get(reference)?.value;
    return hit !== void 0 && hit.length > 0 ? hit : void 0;
  };
  const attachments = () => ctx.get("attachments");
  const adapter = new CommandCodeAdapter({
    profiles,
    catalogFor,
    resolveApiKey,
    pool: poolEngine,
    resolveCredential,
    log: (message) => ctx.logger.warn(message),
    readImage: async (ref, signal) => {
      const store = attachments();
      if (store === void 0) return void 0;
      try {
        const stored = await store.readImage(ref, signal);
        return { data: stored.data, mediaType: ref.mediaType };
      } catch {
        return void 0;
      }
    },
    readUserImage: async (ref, target, signal) => {
      const store = attachments();
      if (store === void 0) return void 0;
      try {
        const version = await store.readImageRequest(ref, target, signal);
        return { data: version.data, mediaType: version.mediaType };
      } catch {
        return void 0;
      }
    }
  });
  const directoryEntries = () => [...profiles().values()].map((profile) => ({
    provider: profile.route,
    displayName: profile.displayName,
    settingsNs,
    settingsPath: ["providers", profile.route],
    // Every route exists only because configuration named it; the adapter
    // ships no route catalog of its own.
    declared: true
  }));
  let directory;
  let directoryFacts;
  const ensureDirectory = () => {
    const entries = directoryEntries();
    if (directoryFacts !== void 0 && deepEqualJson(entries, directoryFacts)) return;
    if (directory === void 0) {
      if (entries.length === 0) {
        directoryFacts = entries;
        return;
      }
      directory = ctx.llm.registerConfigurableProviders(entries);
    } else {
      directory.replace(entries);
    }
    directoryFacts = entries;
  };
  const registrationFacts = () => [...profiles().values()].map((profile) => ({ provider: profile.route, displayName: profile.displayName })).sort((left, right) => left.provider.localeCompare(right.provider));
  let registration;
  let registeredFacts;
  const ensureRegistration = () => {
    const facts = registrationFacts();
    if (registeredFacts !== void 0 && deepEqualJson(facts, registeredFacts)) return;
    const routes = [...profiles().keys()];
    if (registration === void 0) {
      if (routes.length === 0) {
        registeredFacts = facts;
        return;
      }
      registration = ctx.llm.registerAdapter(routes, adapter);
    } else {
      registration.replace(routes);
    }
    registeredFacts = facts;
  };
  ctx.llm.registerPoolOperations(settingsNs, {
    async status(provider) {
      const profile = profiles().get(provider);
      await poolEngine.hydrate(provider);
      return poolEngine.identitiesStatus(provider, profile?.pool?.identities ?? []);
    },
    async resetCooldown(provider, identityId) {
      await poolEngine.hydrate(provider);
      poolEngine.resetCooldown(provider, identityId);
    },
    async testIdentity(_provider, _identityId, _apiKey) {
      return { ok: false, error: "Command Code identity testing is not implemented; run scripts/live-gate.mjs" };
    }
  });
  ctx.on("internal/config", function(_raw, next) {
    const raw = next();
    if (this !== ctx.fiber) return raw;
    parseProfiles(providersOf(raw));
    return raw;
  });
  ensureDirectory();
  ensureRegistration();
  ctx.on("loader/volatile-update", () => {
    try {
      ensureRegistration();
      ensureDirectory();
    } catch (error) {
      ctx.logger.error("commandcode-provider: configuration conflicts with an existing provider route");
      ctx.logger.error(error);
    }
  });
}
export {
  Config,
  apply,
  inject,
  name
};
