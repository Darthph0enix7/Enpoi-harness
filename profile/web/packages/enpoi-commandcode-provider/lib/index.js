// src/index.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
    this.pending ??= this.fetchLive().then((entries) => {
      this.resolved = entries;
      this.origin = "live";
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
import { attributionHeaders, LlmAdapter, LlmError as LlmError2 } from "@deepseek-ai/dsh-llm";

// src/convert.ts
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
function convertUserContent(content, forwarder, resolveImage, plan) {
  if (typeof content === "string") return content;
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
  if (!hasMultimodal) return parts.map((part) => part.type === "text" ? String(part.text) : "").join("\n");
  return parts;
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
        content: convertUserContent(message.content, forwarder, input.resolveImage, userImagePlan)
      });
      continue;
    }
    if (message.role === "assistant") {
      const parts = [];
      if (typeof message.content !== "string") {
        for (const part of message.content) {
          if (part.type === "text" && typeof part.text === "string") {
            parts.push({ type: "text", text: part.text });
          } else if (part.type === "reasoning" && typeof part.text === "string") {
            parts.push({ type: "reasoning", text: part.text });
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
    const value = typeof message.content === "string" ? message.content : message.content.map((part) => toolResultText(part, forwarder)).join("\n");
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
    const key = profile.keyless ? void 0 : await this.options.resolveApiKey(profile);
    if (!profile.keyless && key === void 0) {
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
      tools: toCcTools(options.tools),
      ...options.system === void 0 ? {} : { system: options.system },
      ...options.maxTokens === void 0 ? {} : { maxTokens: options.maxTokens },
      ...options.temperature === void 0 ? {} : { temperature: options.temperature },
      ...effort === void 0 ? {} : { reasoningEffort: effort },
      visionEnabled: visionOf(entry),
      ...this.options.now === void 0 ? {} : { now: this.options.now() }
    });
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
};

// src/index.ts
var name = "commandcode-provider";
var inject = ["llm"];
function loadSnapshot() {
  try {
    const path = fileURLToPath(new URL("../catalog.snapshot.json", import.meta.url));
    return parseCatalog(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return [];
  }
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
    userImageMaxBytes: positiveInteger(record.userImageMaxBytes, "userImageMaxBytes", DEFAULT_USER_IMAGE_MAX_BYTES)
  };
}
function apply(ctx, config) {
  const providers = typeof config === "object" && config !== null ? config.providers : void 0;
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) return;
  const profiles = /* @__PURE__ */ new Map();
  for (const [route, raw] of Object.entries(providers)) {
    const profile = routeFromConfig(route, raw);
    profiles.set(route, profile);
    ctx.logger.info(`commandcode-provider: route "${route}" \u2192 ${profile.baseURL} (${profile.keyless ? "keyless/keypool" : "byok"})`);
  }
  if (profiles.size === 0) return;
  const snapshot = loadSnapshot();
  const catalogs = /* @__PURE__ */ new Map();
  const catalogFor = (profile) => {
    let store = catalogs.get(profile.route);
    if (store === void 0) {
      store = new CatalogStore({ baseURL: profile.baseURL, snapshot });
      catalogs.set(profile.route, store);
      store.start();
    }
    return store;
  };
  const resolveApiKey = async (profile) => {
    if (profile.keyless || profile.apiKeyEnv === void 0) return void 0;
    const credentials = ctx.get("credentials");
    if (credentials === void 0) return void 0;
    const hit = await credentials.resolve(profile.apiKeyEnv);
    return hit?.value;
  };
  const attachments = () => ctx.get("attachments");
  const adapter = new CommandCodeAdapter({
    profiles: () => profiles,
    catalogFor,
    resolveApiKey,
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
  ctx.llm.registerAdapter([...profiles.keys()], adapter);
}
export {
  apply,
  inject,
  name
};
