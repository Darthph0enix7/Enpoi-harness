// src/index.ts
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import Schema from "@deepseek-ai/schemastery";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
var name = "enpoi-worker-credentials";
var Config = Schema.object({
  serverId: Schema.string().required().pattern(/^[A-Za-z0-9_-]{1,32}$/u),
  secretDir: Schema.string().min(1)
});
var MAX_BEARER_BYTES = 8192;
var FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
var BEARER = /^[A-Za-z0-9._~+/-]+=*$/u;
function unavailable() {
  return new Error("Worker MCP credential unavailable");
}
async function readBearer(dir, uid, ref) {
  try {
    const parent = await lstat(dir);
    if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 4095) !== 448) throw unavailable();
    const handle = await open(join(dir, ref), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== uid || (metadata.mode & 4095) !== 384 || metadata.size > MAX_BEARER_BYTES) throw unavailable();
      const still = await lstat(dir);
      if (still.dev !== parent.dev || still.ino !== parent.ino || (still.mode & 4095) !== 448) throw unavailable();
      const buffer = Buffer.alloc(MAX_BEARER_BYTES + 1);
      let offset = 0;
      while (offset < buffer.byteLength) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > MAX_BEARER_BYTES) throw unavailable();
      const bearer = buffer.toString("utf8", 0, offset).replace(/\r?\n$/u, "");
      if (!BEARER.test(bearer)) throw unavailable();
      return bearer;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw unavailable();
  }
}
function createHeaderProvider(config, get) {
  const uid = process.getuid?.();
  if (uid === void 0) throw new Error("Worker MCP credentials require POSIX file ownership");
  const dir = config.secretDir ?? dshHomePath("worker-secrets");
  const selectedServer = config.serverId;
  if (!isAbsolute(dir) || !/^[A-Za-z0-9_-]{1,32}$/u.test(selectedServer)) {
    throw new Error("Worker MCP credentials require an absolute secretDir and a valid serverId");
  }
  return {
    async headersFor(sessionId, serverId) {
      if (sessionId === void 0 || serverId !== selectedServer) return void 0;
      const before = get(sessionId);
      if (before === void 0 || before.revoked === true || before.expiresAt <= Date.now() || before.mcpEndpointId !== selectedServer || before.credentialRef === void 0) return void 0;
      const { credentialRef, jobId, fence } = before;
      if (!FILE_NAME.test(credentialRef) || !/^[!-~]+$/u.test(jobId) || !Number.isSafeInteger(fence) || fence <= 0) throw unavailable();
      const bearer = await readBearer(dir, uid, credentialRef);
      if (bearer === void 0) return void 0;
      const current = get(sessionId);
      if (current === void 0 || current.revoked === true || current.expiresAt <= Date.now() || current.jobId !== jobId || current.fence !== fence || current.credentialRef !== credentialRef || current.mcpEndpointId !== selectedServer) return void 0;
      return { Authorization: `Bearer ${bearer}`, "X-Jarvis-Job-ID": jobId, "X-Jarvis-Job-Fence": String(fence) };
    }
  };
}
function apply(ctx, config) {
  ctx.provide("mcpHeaderProvider", createHeaderProvider(config, (sessionId) => {
    const bindings = ctx.get("peerJobBindings");
    return bindings?.get(sessionId);
  }));
}
export {
  Config,
  apply,
  createHeaderProvider,
  name
};
