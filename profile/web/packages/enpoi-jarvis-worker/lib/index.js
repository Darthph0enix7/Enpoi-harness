// src/index.ts
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { REMOTE_STREAM_MUX_PATH } from "@deepseek-ai/dsh-api-gateway/stream-protocol";
import { PEER_WIRE_DESCRIPTORS, policyAllowsModel, withPeerAuth } from "@deepseek-ai/dsh-api-peer";
import { remoteErrorOf } from "@deepseek-ai/dsh-typert-protocol";
import Schema from "@deepseek-ai/schemastery";
var { WebSocket, WebSocketServer } = createRequire(import.meta.url)("ws");
var provider = "jarvis-worker";
var maxBody = 256 * 1024;
var maxStreamBuffer = 1024 * 1024;
var unary = new Set(PEER_WIRE_DESCRIPTORS.filter((row) => row.mode === "unary").map((row) => row.method.slice("peer.".length)));
var name = "enpoi-jarvis-worker";
var inject = ["llm", "typertGateway", "peerService", "tools", "mcpHeaderProvider", "peerProfileIdentity", "tokenMeter"];
var Config = Schema.object({
  model: Schema.string().required().pattern(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u),
  port: Schema.natural().min(0).max(65535).required()
});
function routing(ctx, model) {
  const describe = async () => {
    try {
      const info = await ctx.llm.resolveModelInfo(provider, model, AbortSignal.timeout(1e3));
      return {
        provider,
        model,
        tools: info.tools ?? "unknown",
        vision: "unknown",
        zeroPrice: "unknown",
        gated: "unknown",
        trainsOnData: "unknown",
        reasoningEfforts: [],
        ...info.context === void 0 ? {} : { contextWindow: info.context.contextWindow }
      };
    } catch {
      return void 0;
    }
  };
  const service = {
    async evaluate(policy, selection) {
      if (selection.chain !== void 0) return { allowed: false, reason: "chain-not-allowed", denied: selection.chain };
      const denied = `${selection.provider}/${selection.model}`;
      if (!policyAllowsModel(policy, selection.provider, selection.model)) return { allowed: false, reason: "model-not-allowed", denied };
      if (selection.provider !== provider || selection.model !== model) return { allowed: false, reason: "unknown-route", denied };
      if (policy.requireZeroPrice === true) return { allowed: false, reason: "price-unproven", denied };
      if (policy.requireNoTraining === true) return { allowed: false, reason: "training-unproven", denied };
      if (selection.reasoningEffort !== void 0) return { allowed: false, reason: "effort-not-allowed", denied };
      const info = await describe();
      if (info === void 0) return { allowed: false, reason: "unknown-route", denied };
      if (info.tools !== true) return { allowed: false, reason: "tools-unproven", denied };
      return { allowed: true, selection };
    },
    async discover(policy, request2) {
      if (request2.cursor !== void 0 || !(await service.evaluate(policy, { provider, model })).allowed) return { models: [], chains: [] };
      const row = await describe();
      const filter = request2.filter;
      const visible = row !== void 0 && filter?.zeroPrice === void 0 && filter?.gated === void 0 && filter?.tools !== false && (filter?.minContextWindow === void 0 || (row.contextWindow ?? 0) >= filter.minContextWindow);
      return { models: visible ? [row] : [], chains: [] };
    }
  };
  return service;
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function respond(res, status, value) {
  if (res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(value));
}
function allowedIngress(req) {
  return /^127\.0\.0\.1(?::\d+)?$/u.test(req.headers.host ?? "") && req.headers.origin === void 0;
}
function failure(error) {
  const remote = remoteErrorOf(error);
  return { code: remote?.code ?? "gateway/internal", message: "Worker peer request refused", details: remote?.details ?? {} };
}
async function request(ctx, req, res) {
  const method = /^\/api\/peer\/([A-Za-z]+)$/u.exec(req.url ?? "")?.[1];
  if (req.method !== "POST" || method === void 0 || !unary.has(method)) {
    respond(res, 404, {});
    return;
  }
  if (typeof req.headers.authorization !== "string") {
    respond(res, 401, {});
    return;
  }
  if (!allowedIngress(req)) {
    respond(res, 403, {});
    return;
  }
  const lifetime = new AbortController();
  res.once("close", () => lifetime.abort());
  const buf = [];
  let bytes = 0;
  let rpcId = "invalid";
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += buffer.length;
      if (bytes > maxBody) {
        respond(res, 413, {});
        return;
      }
      buf.push(buffer);
    }
    const envelope = record(JSON.parse(Buffer.concat(buf).toString("utf8")));
    const args = record(record(envelope?.payload)?.args);
    if (envelope?.type !== "client-request" || envelope.method !== `peer/${method}` || args === void 0 || typeof envelope.rpcId !== "string" || envelope.rpcId.length > 256) {
      respond(res, 400, {});
      return;
    }
    rpcId = envelope.rpcId;
    const value = await withPeerAuth(req.headers.authorization, () => ctx.typertGateway.invoke({
      namespace: "peer",
      method,
      args,
      signal: lifetime.signal
    }));
    respond(res, 200, { type: "server-response", rpcId, result: { ok: true, value } });
  } catch (error) {
    respond(res, 200, { type: "server-response", rpcId, result: { ok: false, error: failure(error) } });
  }
}
function follow(ctx, req, ws) {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(18e4)]);
  let active;
  let streamId;
  const acknowledgements = new Readable({ objectMode: true, highWaterMark: 16, read() {
  } });
  const opening = setTimeout(() => ws.terminate(), 5e3).unref();
  function send(type, payload = {}) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    const frame = JSON.stringify({ type, streamId, ...payload });
    if (Buffer.byteLength(frame) + ws.bufferedAmount > maxStreamBuffer) {
      ws.terminate();
      return false;
    }
    ws.send(frame);
    return true;
  }
  ws.on("error", () => ws.terminate());
  signal.addEventListener("abort", () => ws.terminate(), { once: true });
  ws.on("message", (data, isBinary) => {
    let message;
    try {
      if (!isBinary) message = record(JSON.parse(data.toString()));
    } catch {
      ws.terminate();
      return;
    }
    if (message?.type === "cancel" && streamId !== void 0 && message.streamId === streamId) {
      ws.terminate();
      return;
    }
    if (message?.type === "item" && streamId !== void 0 && message.streamId === streamId) {
      const ack = record(message.value);
      if (ack?.type !== "ack" || !Number.isSafeInteger(ack.frame) || !acknowledgements.push({ type: "ack", frame: ack.frame })) ws.terminate();
      return;
    }
    if (active !== void 0 || message?.type !== "open" || message.endpoint !== "peer/follow" || typeof message.streamId !== "string" || message.streamId.length > 256) {
      ws.terminate();
      return;
    }
    const args = record(record(message.payload)?.args);
    if (args === void 0) {
      ws.terminate();
      return;
    }
    clearTimeout(opening);
    streamId = message.streamId;
    active = withPeerAuth(req.headers.authorization, async () => {
      try {
        const stream = await ctx.typertGateway.stream({ namespace: "peer", method: "follow", args, signal, uplink: acknowledgements });
        for await (const value of stream) if (!send("item", { value })) return;
        send("end");
      } catch (error) {
        send("error", { error: failure(error) });
      } finally {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      }
    }).catch(() => {
      ws.terminate();
    });
  });
  return new Promise((resolve) => {
    ws.once("close", () => {
      clearTimeout(opening);
      lifetime.abort();
      acknowledgements.push(null);
      if (active === void 0) resolve();
      else void active.then(resolve);
    });
  });
}
async function apply(ctx, config) {
  ctx.provide("peerRouting", routing(ctx, config.model));
  ctx.on("llm/stream", (options, next) => {
    if (options.provider !== provider || options.model !== config.model || options.chain !== void 0) {
      throw new Error("Jarvis worker refused a model route other than its pinned route");
    }
    return next();
  }, { prepend: true });
  const requests = /* @__PURE__ */ new Set();
  const server = createServer({ requestTimeout: 1e4, headersTimeout: 5e3 }, (req, res) => {
    const pending = request(ctx, req, res).catch(() => {
      res.destroy();
    });
    requests.add(pending);
    void pending.then(() => {
      requests.delete(pending);
    });
  });
  server.maxConnections = 16;
  server.setTimeout(1e4, (socket) => socket.destroy());
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  const followers = /* @__PURE__ */ new Set();
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== REMOTE_STREAM_MUX_PATH || !allowedIngress(req) || typeof req.headers.authorization !== "string" || followers.size >= 4) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      const done = follow(ctx, req, ws);
      followers.add(done);
      void done.then(() => {
        followers.delete(done);
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address !== null && typeof address === "object") ctx.provide("jarvisWorkerPort", address.port);
  ctx.effect(() => async () => {
    const unlisten = new Promise((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
    for (const ws of sockets.clients) ws.terminate();
    await Promise.all([unlisten, new Promise((resolve) => {
      sockets.close(() => {
        resolve();
      });
    }), ...followers, ...requests]);
  }, "jarvis worker peer carrier");
}
export {
  Config,
  apply,
  inject,
  name
};
