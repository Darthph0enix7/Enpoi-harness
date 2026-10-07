// src/index.ts
import Schema from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { join as join4 } from "node:path";
import { randomUUID as randomUUID2, createHash as createHash2 } from "node:crypto";
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync2 } from "node:fs";

// src/blob-store.ts
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, unlink, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
var BlobStore = class {
  constructor(rootDir) {
    this.rootDir = rootDir;
  }
  async init() {
    await mkdir(this.rootDir, { recursive: true });
  }
  async put(bytes) {
    const sha = sha256Of(bytes);
    const path = join(this.rootDir, sha);
    try {
      await writeFile(path, bytes, { flag: "wx" });
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    return sha;
  }
  async get(sha) {
    if (sha === null) return null;
    return readFile(join(this.rootDir, sha));
  }
  /**
   * Reachability GC: sweep unreferenced blobs older than ttlMs.
   * @param liveShas — every SHA referenced by live records anywhere
   */
  async gc(liveShas, ttlMs, now = Date.now()) {
    const live2 = new Set(liveShas);
    const entries = await readdir(this.rootDir);
    for (const name2 of entries) {
      if (live2.has(name2)) continue;
      const path = join(this.rootDir, name2);
      try {
        const st = await stat(path);
        if (now - st.mtimeMs > ttlMs) await unlink(path);
      } catch {
      }
    }
  }
};

// src/manifest.ts
import { mkdir as mkdir2, readFile as readFile2, appendFile } from "node:fs/promises";
import { appendFileSync, mkdirSync } from "node:fs";
import { join as join2 } from "node:path";
var LOG_DIR = join2(process.env.HOME ?? "", ".dsh", "logs");
function diag(line) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join2(LOG_DIR, "enpoi-file-revert.log"), `[${(/* @__PURE__ */ new Date()).toISOString()}] ${line}
`);
  } catch {
  }
}
var MutationManifest = class {
  constructor(filePath) {
    this.filePath = filePath;
    this.ready = this.init();
  }
  records = [];
  ready;
  async init() {
    try {
      const raw = await readFile2(this.filePath, "utf8");
      this.records = [];
      const lines = raw.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length === 0) continue;
        try {
          const record = JSON.parse(line);
          if (record.preBlobSha === null && record.postBlobSha === null) continue;
          this.records.push(record);
        } catch {
          if (i !== lines.length - 1) throw new Error(`corrupt manifest line ${i + 1}`);
        }
      }
      const lastPost = /* @__PURE__ */ new Map();
      for (const record of this.records) {
        const prior = lastPost.get(record.targetKey);
        record.isInterleaved = prior !== void 0 && prior !== record.preBlobSha;
        lastPost.set(record.targetKey, record.postBlobSha);
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  async append(record) {
    await this.ready;
    const prior = this.lastFor(record.targetKey);
    if (prior !== void 0 && prior.postBlobSha !== record.preBlobSha) {
      record.isInterleaved = true;
      diag(`append: interleaved for ${record.targetKey} \u2014 prior toolSeq=${prior.toolSeq} post=${String(prior.postBlobSha).slice(0, 10)} vs incoming pre=${String(record.preBlobSha).slice(0, 10)}`);
    }
    this.records.push(record);
    await mkdir2(join2(this.filePath, ".."), { recursive: true });
    await appendFile(this.filePath, JSON.stringify(record) + "\n", "utf8");
    return record;
  }
  lastFor(targetKey) {
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i].targetKey === targetKey) return this.records[i];
    }
    return void 0;
  }
  inSpan(fromSeq) {
    return this.records.filter((r) => r.toolSeq >= fromSeq);
  }
  upTo(seq) {
    return this.records.filter((r) => r.toolSeq <= seq);
  }
  isSessionCreated(targetKey) {
    const recs = this.records.filter((r) => r.targetKey === targetKey);
    if (recs.length === 0) return false;
    const earliest = recs.reduce((a, b) => b.toolSeq < a.toolSeq ? b : a);
    return !earliest.preExisted;
  }
  aggregateSpan(fromSeq) {
    const span = this.inSpan(fromSeq);
    const byKey = /* @__PURE__ */ new Map();
    for (const rec of span) {
      let entry = byKey.get(rec.targetKey);
      if (entry === void 0) {
        entry = {
          initialPre: rec,
          finalPost: rec,
          records: [],
          sessionCreated: this.isSessionCreated(rec.targetKey)
        };
        byKey.set(rec.targetKey, entry);
      }
      entry.records.push(rec);
      if (rec.toolSeq < entry.initialPre.toolSeq) entry.initialPre = rec;
    }
    for (const entry of byKey.values()) {
      const authored = entry.records.filter((r) => r.source !== "plugin-revert");
      const pool = authored.length > 0 ? authored : entry.records;
      entry.finalPost = pool.reduce((a, b) => b.toolSeq > a.toolSeq ? b : a);
    }
    return byKey;
  }
  /**
   * Chain-derived interleaving for one record: a record is interleaved iff its
   * pre-state differs from the previous record's post-state for the same key.
   * This recomputes from the chain instead of trusting stored flags — a stale
   * or poisoned `isInterleaved` (e.g. written by an older build during a
   * restart window) must never degrade a clean target into a spurious
   * "Snapshot unavailable" conflict (FR1/FR5 backwards-compat).
   */
  chainInterleaved(spanRecs, index) {
    if (index <= 0) return false;
    const prior = spanRecs[index - 1];
    return prior.postBlobSha !== spanRecs[index].preBlobSha;
  }
  /**
   * Resolve the target state for a boundary: latest mutation ≤ seq (post),
   * falling back to the initial pre-state; `null` boundary resolves to the
   * final post-state (restore-all).
   */
  resolveRestoreTarget(targetKey, restoreSeq) {
    const sessionCreated = this.isSessionCreated(targetKey);
    if (restoreSeq === null) {
      const spanRecs = this.records.filter((r) => r.targetKey === targetKey);
      if (spanRecs.length === 0) {
        return { preExisted: false, preStatus: "ok", preBlobSha: null, postBlobSha: null, isInterleaved: false, sessionCreated };
      }
      const earliest = spanRecs.reduce((a, b) => b.toolSeq < a.toolSeq ? b : a);
      const userRecs = spanRecs.filter((r) => r.source !== "plugin-revert");
      const latest2 = (userRecs.length > 0 ? userRecs : spanRecs).reduce((a, b) => b.toolSeq > a.toolSeq ? b : a);
      const latestIdx2 = spanRecs.indexOf(latest2);
      const successor2 = spanRecs[latestIdx2 + 1];
      const targetInterleaved2 = this.chainInterleaved(spanRecs, latestIdx2) || successor2 !== void 0 && this.chainInterleaved(spanRecs, latestIdx2 + 1);
      return {
        preExisted: earliest.preExisted,
        preStatus: earliest.preStatus,
        preBlobSha: earliest.preBlobSha,
        postBlobSha: latest2.postBlobSha,
        isInterleaved: targetInterleaved2,
        sessionCreated,
        targetSource: latest2.source
      };
    }
    const recs = this.upTo(restoreSeq).filter((r) => r.targetKey === targetKey);
    if (recs.length === 0) {
      const spanRecs = this.records.filter((r) => r.targetKey === targetKey);
      if (spanRecs.length === 0) {
        return { preExisted: false, preStatus: "ok", preBlobSha: null, postBlobSha: null, isInterleaved: false, sessionCreated };
      }
      const earliest = spanRecs.reduce((a, b) => b.toolSeq < a.toolSeq ? b : a);
      return {
        preExisted: earliest.preExisted,
        preStatus: earliest.preStatus,
        preBlobSha: earliest.preBlobSha,
        postBlobSha: null,
        isInterleaved: false,
        sessionCreated
      };
    }
    const earliestSpan = this.records.filter((r) => r.targetKey === targetKey).reduce((a, b) => b.toolSeq < a.toolSeq ? b : a);
    const latest = recs.reduce((a, b) => b.toolSeq > a.toolSeq ? b : a);
    const spanAll = this.records.filter((r) => r.targetKey === targetKey).sort((a, b) => a.toolSeq - b.toolSeq);
    const latestIdx = spanAll.indexOf(latest);
    const successor = spanAll[latestIdx + 1];
    const targetInterleaved = this.chainInterleaved(spanAll, latestIdx) || successor !== void 0 && this.chainInterleaved(spanAll, latestIdx + 1);
    return {
      preExisted: earliestSpan.preExisted,
      preStatus: earliestSpan.preStatus,
      preBlobSha: earliestSpan.preBlobSha,
      postBlobSha: latest.postBlobSha,
      isInterleaved: targetInterleaved,
      sessionCreated,
      targetSource: latest.source
    };
  }
  /** All SHAs referenced by live records (for reachability GC). */
  liveShas() {
    const shas = /* @__PURE__ */ new Set();
    for (const r of this.records) {
      if (r.preBlobSha !== null) shas.add(r.preBlobSha);
      if (r.postBlobSha !== null) shas.add(r.postBlobSha);
    }
    return shas;
  }
};

// src/evaluator.ts
var STATE = {
  CLEAN_RESTORE: "clean_restore",
  CLEAN_TRASH: "clean_trash",
  ALREADY_CLEAN: "already_clean",
  CONFLICT: "conflict",
  ALREADY_ABSENT: "already_absent",
  MISSING: "missing",
  UNAVAILABLE: "unavailable"
};
function evaluateBoundary(entry, target, currentSha) {
  const { initialPre, finalPost } = entry;
  const postSha = finalPost.postBlobSha;
  const targetSha = target.postBlobSha ?? target.preBlobSha;
  const targetAbsent = target.postBlobSha === null && target.preBlobSha === null;
  if (initialPre.preExisted && initialPre.preStatus !== "ok") {
    return {
      state: STATE.UNAVAILABLE,
      action: "skip",
      targetBlobSha: null,
      expectedDiskSha: currentSha,
      targetAbsent,
      reason: `pre-agent snapshot unavailable (${initialPre.preStatus})`
    };
  }
  if (finalPost.postStatus !== "ok" || postSha === null) {
    return {
      state: STATE.UNAVAILABLE,
      action: "skip",
      targetBlobSha: targetSha,
      expectedDiskSha: currentSha,
      targetAbsent,
      reason: `post-agent snapshot unavailable (${finalPost.postStatus})`
    };
  }
  if (currentSha === null) {
    if (targetAbsent) {
      return { state: STATE.ALREADY_ABSENT, action: "noop", targetBlobSha: null, expectedDiskSha: null, targetAbsent: true };
    }
    const isSessionCreated = entry.sessionCreated ?? !initialPre.preExisted;
    if (isSessionCreated) {
      return {
        state: STATE.CLEAN_RESTORE,
        action: "restore",
        targetBlobSha: targetSha,
        expectedDiskSha: null,
        targetAbsent: false
      };
    }
    return {
      state: STATE.MISSING,
      action: "prompt",
      targetBlobSha: targetSha,
      expectedDiskSha: null,
      targetAbsent: false,
      reason: "file is missing on disk but the revert boundary expects it to exist"
    };
  }
  if (currentSha === targetSha) {
    return { state: STATE.ALREADY_CLEAN, action: "noop", targetBlobSha: null, expectedDiskSha: currentSha, targetAbsent };
  }
  const isKnownSpanState = entry.records.some((r) => r.source !== "user-kept" && r.postBlobSha !== null && r.postBlobSha === currentSha) || entry.records.some((r) => r.source !== "user-kept" && !r.isInterleaved && r.preBlobSha !== null && r.preBlobSha === currentSha);
  if (isKnownSpanState) {
    if (targetAbsent) {
      if (target.preExisted) {
        return {
          state: STATE.UNAVAILABLE,
          action: "skip",
          targetBlobSha: null,
          expectedDiskSha: currentSha,
          targetAbsent: true,
          reason: "target is absent but file pre-existed before span"
        };
      }
      return {
        state: STATE.CLEAN_TRASH,
        action: "trash",
        targetBlobSha: null,
        expectedDiskSha: currentSha,
        targetAbsent: true
      };
    }
    return {
      state: STATE.CLEAN_RESTORE,
      action: "restore",
      targetBlobSha: targetSha,
      expectedDiskSha: currentSha,
      targetAbsent: false
    };
  }
  return {
    state: STATE.CONFLICT,
    action: "prompt",
    targetBlobSha: targetSha,
    expectedDiskSha: currentSha,
    targetAbsent,
    reason: "current disk content differs from all known agent mutation states in the span"
  };
}

// src/executor.ts
import { mkdir as mkdir3, readFile as readFile3, appendFile as appendFile2, writeFile as writeFile2, rename } from "node:fs/promises";
import { join as join3, dirname } from "node:path";
import { randomUUID } from "node:crypto";
var RevertExecutor = class {
  constructor(opts) {
    this.opts = opts;
    this.ready = this.init();
  }
  wal = [];
  ready;
  async init() {
    await mkdir3(this.opts.trashRoot, { recursive: true });
    try {
      const raw = await readFile3(this.opts.walFile, "utf8");
      const lines = raw.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length === 0) continue;
        try {
          this.wal.push(JSON.parse(line));
        } catch {
          if (i !== lines.length - 1) throw new Error(`corrupt WAL line ${i + 1}`);
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  /** Append-only WAL write (never full-file rewrite). */
  async writeWal(entry) {
    await this.ready;
    this.wal.push(entry);
    await mkdir3(dirname(this.opts.walFile), { recursive: true });
    await appendFile2(this.opts.walFile, JSON.stringify(entry) + "\n", "utf8");
  }
  /** Atomic write: temp file in same dir + rename (crash-safe, same-filesystem). */
  async atomicWrite(targetPath, bytes) {
    const dir = dirname(targetPath);
    await mkdir3(dir, { recursive: true });
    const tmp = join3(dir, `.fr-tmp-${randomUUID()}`);
    await writeFile2(tmp, bytes);
    await rename(tmp, targetPath);
  }
  /** Move a file to the trash staging area; unique dest (uuid) prevents collisions. */
  async trash(targetPath, sessionId) {
    const destDir = join3(this.opts.trashRoot, sessionId, String(Date.now()));
    await mkdir3(destDir, { recursive: true });
    const dest = join3(destDir, `${randomUUID()}-${targetPath.split("/").pop() ?? "file"}`);
    await rename(targetPath, dest);
    return dest;
  }
  /**
   * Execute a revert plan with WAL protection.
   * On unexpected exception: DO NOT seal — leave the intent unsealed so
   * startup recovery re-runs it (idempotent by hash).
   */
  async execute(opts) {
    const intent = {
      kind: "intent",
      sessionId: opts.sessionId,
      revertSeq: opts.revertSeq,
      plan: Object.fromEntries([...opts.plan].map(([key, p]) => [key, { action: p.action, targetBlobSha: p.targetBlobSha, expectedDiskSha: p.expectedDiskSha }])),
      ts: Date.now()
    };
    await this.writeWal(intent);
    const outcomes = {};
    let interrupted = false;
    try {
      for (const [targetKey, p] of opts.plan) {
        let action = p.action.startsWith("resolve:") ? p.action.slice("resolve:".length) : p.action;
        if (action === "keep") action = "noop";
        if (action === "noop") {
          outcomes[targetKey] = { status: "no_op" };
          continue;
        }
        if (action === "recreate") {
          outcomes[targetKey] = { status: "conflict_escalated", reason: "beside resolution cannot be replayed after a crash \u2014 resolve the conflict again" };
          continue;
        }
        if (action === "prompt" || action === "skip") {
          outcomes[targetKey] = { status: "pending_conflict" };
          continue;
        }
        const current = await opts.readDisk(targetKey);
        const currentSha = current === null ? null : sha256Of(current);
        if (currentSha !== p.expectedDiskSha) {
          outcomes[targetKey] = { status: "conflict_escalated", reason: "disk changed between evaluation and write" };
          continue;
        }
        if (current !== null) {
          try {
            await this.opts.blobStore.put(current);
          } catch (err) {
            outcomes[targetKey] = { status: "conflict_escalated", reason: `pre-clobber backup failed: ${String(err)}` };
            continue;
          }
        }
        const path = await opts.resolvePath(targetKey);
        if (action === "restore") {
          let bytes;
          try {
            bytes = await this.opts.blobStore.get(p.targetBlobSha);
          } catch {
            outcomes[targetKey] = { status: "conflict_escalated", reason: "pre-agent blob missing from store" };
            continue;
          }
          if (bytes === null) {
            outcomes[targetKey] = { status: "conflict_escalated", reason: "pre-agent blob missing from store" };
            continue;
          }
          await opts.writeDisk(path, bytes);
          const verify = await opts.readDisk(targetKey);
          if (verify === null || sha256Of(verify) !== p.targetBlobSha) {
            outcomes[targetKey] = { status: "conflict_escalated", reason: "post-write verification failed" };
            continue;
          }
          outcomes[targetKey] = { status: "restored", fromSha: p.expectedDiskSha, toSha: p.targetBlobSha };
        } else if (action === "trash") {
          const dest = await opts.trashFile(path);
          outcomes[targetKey] = { status: "trashed", dest, fromSha: p.expectedDiskSha, toSha: null };
        }
      }
    } catch (err) {
      interrupted = true;
      outcomes._error = { status: "error", _error: String(err) };
      return { outcomes, interrupted, sealed: false };
    }
    await this.writeWal({ kind: "result", sessionId: opts.sessionId, revertSeq: opts.revertSeq, outcomes, ts: Date.now() });
    return { outcomes, interrupted, sealed: true };
  }
  /**
   * Apply a user conflict resolution for one file, with the same WAL + TOCTOU
   * discipline as auto-revert.
   */
  async applyResolution(opts) {
    const walSeq = -Date.now();
    await this.writeWal({
      kind: "intent",
      sessionId: opts.sessionId,
      revertSeq: walSeq,
      plan: { [opts.targetKey]: { action: `resolve:${opts.resolution}`, targetBlobSha: opts.targetBlobSha, expectedDiskSha: opts.expectedDiskSha } },
      ts: Date.now()
    });
    try {
      if (opts.resolution === "keep") {
        const outcome2 = { status: "kept" };
        await this.writeWal({ kind: "result", sessionId: opts.sessionId, revertSeq: walSeq, outcomes: { [opts.targetKey]: outcome2 }, ts: Date.now() });
        return outcome2;
      }
      const current = await opts.readDisk(opts.targetKey);
      const currentSha = current === null ? null : sha256Of(current);
      if (currentSha !== opts.expectedDiskSha) {
        const outcome2 = { status: "conflict_escalated", reason: "disk changed since the conflict was presented" };
        await this.writeWal({ kind: "result", sessionId: opts.sessionId, revertSeq: walSeq, outcomes: { [opts.targetKey]: outcome2 }, ts: Date.now() });
        return outcome2;
      }
      if (current !== null) {
        try {
          await this.opts.blobStore.put(current);
        } catch (err) {
          const outcome2 = { status: "conflict_escalated", reason: `pre-clobber backup failed: ${String(err)}` };
          await this.writeWal({ kind: "result", sessionId: opts.sessionId, revertSeq: walSeq, outcomes: { [opts.targetKey]: outcome2 }, ts: Date.now() });
          return outcome2;
        }
      }
      const path = await opts.resolvePath(opts.targetKey);
      const beside = opts.beside === true;
      const verifyPath = beside ? path : opts.targetKey;
      let outcome;
      if (opts.resolution === "restore" || opts.resolution === "recreate") {
        let bytes;
        try {
          bytes = await this.opts.blobStore.get(opts.targetBlobSha);
        } catch {
          outcome = { status: "conflict_escalated", reason: "pre-agent blob missing from store" };
          await this.writeWal({ kind: "result", sessionId: opts.sessionId, revertSeq: walSeq, outcomes: { [opts.targetKey]: outcome }, ts: Date.now() });
          return outcome;
        }
        if (bytes === null) {
          outcome = { status: "conflict_escalated", reason: "pre-agent blob missing from store" };
          await this.writeWal({ kind: "result", sessionId: opts.sessionId, revertSeq: walSeq, outcomes: { [opts.targetKey]: outcome }, ts: Date.now() });
          return outcome;
        }
        await opts.writeDisk(path, bytes);
        const verify = await opts.readDisk(verifyPath);
        if (verify === null || sha256Of(verify) !== opts.targetBlobSha) {
          outcome = { status: "conflict_escalated", reason: "post-write verification failed" };
        } else if (beside) {
          outcome = { status: "saved_beside", dest: path, toSha: opts.targetBlobSha };
        } else {
          outcome = { status: "restored", toSha: opts.targetBlobSha };
        }
      } else if (opts.resolution === "trash") {
        const dest = await opts.trashFile(path);
        outcome = { status: "trashed", dest, fromSha: opts.expectedDiskSha, toSha: null };
      } else {
        outcome = { status: "invalid_resolution" };
      }
      await this.writeWal({ kind: "result", sessionId: opts.sessionId, revertSeq: walSeq, outcomes: { [opts.targetKey]: outcome }, ts: Date.now() });
      return outcome;
    } catch (err) {
      const outcome = { status: "error", reason: String(err) };
      await this.writeWal({ kind: "result", sessionId: opts.sessionId, revertSeq: walSeq, outcomes: { [opts.targetKey]: outcome }, ts: Date.now() });
      return outcome;
    }
  }
  /**
   * Crash recovery: find intents without matching results. Recovery REPLAYS the
   * recorded intent plan verbatim (never re-derives from a grown manifest).
   */
  async findUnsealedIntents() {
    await this.ready;
    const sealed = /* @__PURE__ */ new Set();
    for (const entry of this.wal) {
      if (entry.kind === "result") sealed.add(entry.revertSeq);
    }
    return this.wal.filter((e) => e.kind === "intent" && !sealed.has(e.revertSeq));
  }
  /** All SHAs referenced by WAL intents (for reachability GC). */
  liveShas() {
    const shas = /* @__PURE__ */ new Set();
    for (const entry of this.wal) {
      if (entry.kind !== "intent") continue;
      for (const p of Object.values(entry.plan ?? {})) {
        if (p.targetBlobSha !== null && p.targetBlobSha !== void 0) shas.add(p.targetBlobSha);
      }
    }
    return shas;
  }
};

// src/capture.ts
import { readFile as readFile4 } from "node:fs/promises";
var MUTATION_TOOLS = /* @__PURE__ */ new Set(["edit", "write"]);
async function capturePre(ctx, exec, pendingCaptures, maxSnapshotBytes) {
  if (!MUTATION_TOOLS.has(exec.name)) return;
  const args = exec.arguments;
  const filePath = args.file_path;
  if (typeof filePath !== "string" || filePath.length === 0) return;
  const fs = ctx.get("fs");
  if (fs?.resolve === void 0) return;
  const cwd = exec.agent?.session.header.cwd;
  const target = await fs.resolve(filePath, cwd !== void 0 ? { cwd } : void 0);
  let preExisted = false;
  let preStatus = "ok";
  let preBlobSha = null;
  let preBytes = null;
  try {
    const bytes = await readFile4(target.targetKey);
    preExisted = true;
    if (bytes.length > maxSnapshotBytes) {
      preStatus = "too-large";
    } else {
      preBlobSha = sha256Of(bytes);
      preBytes = bytes;
    }
  } catch (err) {
    if (err.code === "ENOENT") {
      preExisted = false;
    } else {
      preStatus = "unreadable";
    }
  }
  pendingCaptures.set(exec.callId, {
    targetKey: target.targetKey,
    displayPath: target.displayPath,
    preExisted,
    preStatus,
    preBlobSha,
    preBytes
  });
}
async function capturePost(ctx, exec, result, pendingCaptures, manifestFor, blobStore) {
  if (!MUTATION_TOOLS.has(exec.name)) return;
  const pre = pendingCaptures.get(exec.callId);
  pendingCaptures.delete(exec.callId);
  if (pre === void 0) return;
  if (result.isError) return;
  const sessionId = exec.agent?.session.id;
  if (sessionId === void 0) return;
  const session = exec.agent?.session;
  if (session === void 0) return;
  if (pre.preBytes !== null && pre.preBlobSha !== null) {
    await blobStore.put(pre.preBytes);
  }
  let postStatus = "ok";
  let postBlobSha = null;
  try {
    const bytes = await readFile4(pre.targetKey);
    postBlobSha = sha256Of(bytes);
    await blobStore.put(bytes);
  } catch (err) {
    if (err.code === "ENOENT") {
      postStatus = "unreadable";
    } else {
      postStatus = "unreadable";
    }
  }
  let toolSeq = -1;
  const events = session.snapshotEvents();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "tool/call" && e.data.callId === exec.callId) {
      toolSeq = e.seq;
      break;
    }
  }
  if (toolSeq === -1) return;
  await manifestFor(sessionId).append({
    sessionId,
    toolSeq,
    callId: exec.callId,
    targetKey: pre.targetKey,
    displayPath: pre.displayPath,
    operation: pre.preExisted ? "update" : "create",
    preExisted: pre.preExisted,
    preStatus: pre.preStatus,
    preBlobSha: pre.preBlobSha,
    postStatus,
    postBlobSha,
    isInterleaved: false,
    timestamp: Date.now()
  });
}

// src/index.ts
var name = "enpoi-file-revert";
var inject = ["tools", "fs", "sessions", "sessionPersistence", "timer"];
var FILE_HISTORY_ROOT = join4(homedir(), ".dsh", "file-history");
var TRASH_ROOT = join4(homedir(), ".dsh", "trash");
var DIAG_LOG = join4(homedir(), ".dsh", "logs", "enpoi-file-revert.log");
function diag2(msg) {
  try {
    mkdirSync2(join4(homedir(), ".dsh", "logs"), { recursive: true });
    appendFileSync2(DIAG_LOG, `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}
`);
  } catch {
  }
}
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
  /** Maximum snapshot size in bytes; larger files degrade to the unavailable-prompt path. */
  maxSnapshotBytes: live(Schema.number().default(10 * 1024 * 1024)),
  /** Interval for the reachability GC sweep (ms). */
  gcIntervalMs: live(Schema.number().default(6 * 60 * 60 * 1e3)),
  /** Age threshold for unreferenced blobs (ms). */
  gcTtlMs: live(Schema.number().default(30 * 24 * 60 * 60 * 1e3))
});
function apply(ctx, config) {
  const resolved = plainConfig(config);
  diag2(`apply: mounted (maxSnapshotBytes=${resolved.maxSnapshotBytes}, gcIntervalMs=${resolved.gcIntervalMs})`);
  const blobStore = new BlobStore(join4(FILE_HISTORY_ROOT, "blobs"));
  void blobStore.init();
  const pendingCaptures = /* @__PURE__ */ new Map();
  const sessionStates = /* @__PURE__ */ new Map();
  const manifests = /* @__PURE__ */ new Map();
  const executors = /* @__PURE__ */ new Map();
  function manifestFor(sessionId) {
    let m = manifests.get(sessionId);
    if (m === void 0) {
      m = new MutationManifest(join4(FILE_HISTORY_ROOT, sessionId, "manifest.jsonl"));
      manifests.set(sessionId, m);
    }
    return m;
  }
  function executorFor(sessionId) {
    let e = executors.get(sessionId);
    if (e === void 0) {
      e = new RevertExecutor({
        blobStore,
        trashRoot: TRASH_ROOT,
        walFile: join4(FILE_HISTORY_ROOT, sessionId, "wal.jsonl")
      });
      void e.init();
      executors.set(sessionId, e);
    }
    return e;
  }
  function stateFor(session) {
    let s = sessionStates.get(session.id);
    if (s === void 0) {
      let recoveredBoundary = null;
      const events = session.snapshotEvents();
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (ev?.type === "revert/state") {
          recoveredBoundary = ev.data.fromSeq;
          break;
        }
      }
      s = { boundary: recoveredBoundary, initialized: true, flight: Promise.resolve() };
      sessionStates.set(session.id, s);
    }
    return s;
  }
  ctx.on("tools/pre-execute", async (exec, next) => {
    if (exec.name === "edit" || exec.name === "write") {
      try {
        await capturePre(ctx, exec, pendingCaptures, resolved.maxSnapshotBytes);
      } catch (err) {
        diag2(`pre-capture failed for ${exec.name}: ${String(err)}`);
      }
    }
    return next();
  });
  ctx.on("tools/post-execute", async (exec, result, next) => {
    if (exec.name === "edit" || exec.name === "write") {
      try {
        await capturePost(ctx, exec, result, pendingCaptures, manifestFor, blobStore);
      } catch (err) {
        diag2(`post-capture failed for ${exec.name}: ${String(err)}`);
      }
    }
    return next();
  });
  ctx.on("session/event", (session, event) => {
    if (event.type !== "revert/state") return;
    const data = event.data;
    const fromSeq = data.fromSeq;
    const cause = data.cause ?? (fromSeq === null ? "restore" : "revert");
    diag2(`revert/state: session=${session.id} fromSeq=${String(fromSeq)} cause=${cause}`);
    const state = stateFor(session);
    const oldBoundary = state.boundary;
    const newBoundary = fromSeq;
    state.boundary = newBoundary;
    if (cause === "commit") {
      diag2(`revert/state: commit for ${session.id} \u2014 clearing boundary without file execution`);
      return;
    }
    if (cause === "restore" && newBoundary !== null && newBoundary === oldBoundary) {
      diag2(`revert/state: equal-seq restore no-op for ${session.id} (boundary=${String(newBoundary)})`);
      return;
    }
    state.flight = state.flight.then(async () => {
      try {
        await executeFileTransition(ctx, session, oldBoundary, newBoundary, manifestFor, executorFor, blobStore);
      } catch (err) {
        diag2(`revert execution FAILED for ${session.id}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        try {
          appendIgnorable(session, "revert/file-result", {
            revertSeq: fromSeq ?? -1,
            outcomes: { _error: { status: "error", reason: err instanceof Error ? err.message : String(err) } }
          });
        } catch {
        }
      }
    });
  });
  const onAny = ctx.on;
  onAny("file-revert/resolve", async (...args) => {
    diag2(`file-revert/resolve received: ${JSON.stringify(args[0])}`);
    const request = args[0];
    try {
      const outcome = await applyConflictResolution(ctx, request, executorFor, blobStore, stateFor, manifestFor);
      diag2(`file-revert/resolve outcome: ${JSON.stringify(outcome)}`);
      return { accepted: true, ...outcome };
    } catch (err) {
      diag2(`file-revert/resolve ERROR: ${String(err)}`);
      return { accepted: false, reason: String(err) };
    }
  });
  void recoverUnsealedIntents(ctx, executorFor, manifestFor);
  const timer = ctx.get("timer");
  if (timer?.setInterval !== void 0) {
    timer.setInterval(() => {
      void runGc(manifests, executors, blobStore, resolved.gcTtlMs).catch((err) => {
        diag2(`GC sweep failed: ${String(err)}`);
      });
    }, resolved.gcIntervalMs);
  }
  onAny("dispose", () => {
    pendingCaptures.clear();
    sessionStates.clear();
  });
}
function appendIgnorable(session, type, data) {
  session.append(type, data);
}
async function executeFileTransition(ctx, session, oldBoundary, newBoundary, manifestFor, executorFor, _blobStore) {
  const manifest = manifestFor(session.id);
  const executor = executorFor(session.id);
  const isRevert = newBoundary !== null && (oldBoundary === null || newBoundary <= oldBoundary);
  const isRestore = newBoundary === null && oldBoundary !== null || newBoundary !== null && oldBoundary !== null && newBoundary > oldBoundary;
  if (!isRevert && !isRestore) {
    diag2(`executeFileTransition: no-op transition for ${session.id} (old=${String(oldBoundary)}, new=${String(newBoundary)})`);
    return;
  }
  const mode = isRevert ? "revert" : "restore";
  const spanStart = isRevert ? newBoundary : oldBoundary;
  const aggregated = manifest.aggregateSpan(spanStart);
  diag2(`executeFileTransition: session=${session.id} mode=${mode} oldBoundary=${String(oldBoundary)} newBoundary=${String(newBoundary)} spanStart=${spanStart} aggregated=${aggregated.size} records=${manifest.records.length}`);
  if (aggregated.size === 0) {
    diag2(`executeFileTransition: no records in span ${spanStart} (toolSeqs: ${manifest.records.map((r) => r.toolSeq).join(",")})`);
    return;
  }
  const activeChildren = await findActiveChildren(ctx, session.id);
  if (activeChildren.length > 0) {
    appendIgnorable(session, "revert/file-result", {
      revertSeq: newBoundary ?? -1,
      outcomes: {
        _guard: { status: "refused", reason: `active subagent fibers: ${activeChildren.join(", ")}` }
      }
    });
    diag2(`file revert refused for ${session.id} \u2014 active children ${activeChildren.join(", ")}`);
    return;
  }
  const plan = /* @__PURE__ */ new Map();
  const conflicts = [];
  for (const [targetKey, entry] of aggregated) {
    const target = manifest.resolveRestoreTarget(targetKey, newBoundary);
    const current = await readDiskBytes(ctx, targetKey);
    const currentSha = current === null ? null : sha256Hex(current);
    let evalResult = evaluateBoundary(entry, target, currentSha);
    if (mode === "restore" && target.targetSource !== "user-kept" && target.isInterleaved && evalResult.action !== "prompt" && evalResult.action !== "skip") {
      evalResult = {
        state: STATE.UNAVAILABLE,
        action: "skip",
        targetBlobSha: evalResult.targetBlobSha,
        expectedDiskSha: currentSha,
        targetAbsent: evalResult.targetAbsent,
        reason: "interleaved user edits make the boundary state unreliable"
      };
    }
    plan.set(targetKey, {
      entry,
      state: evalResult.state,
      action: evalResult.action,
      targetBlobSha: evalResult.targetBlobSha,
      expectedDiskSha: evalResult.expectedDiskSha,
      reason: evalResult.reason
    });
    if (evalResult.state === STATE.CONFLICT || evalResult.state === STATE.MISSING || evalResult.state === STATE.UNAVAILABLE) {
      conflicts.push({
        targetKey,
        displayPath: entry.finalPost.displayPath,
        state: evalResult.state,
        reason: evalResult.reason ?? "",
        mode,
        boundarySeq: newBoundary,
        spanStartSeq: spanStart,
        targetBlobSha: evalResult.targetBlobSha,
        targetAbsent: evalResult.targetAbsent ?? (target.postBlobSha === null && target.preBlobSha === null),
        spanPreExisted: target.preExisted,
        sessionCreated: entry.sessionCreated ?? !entry.initialPre.preExisted,
        preSha: entry.initialPre.preBlobSha,
        postSha: entry.finalPost.postBlobSha,
        currentSha
      });
    }
  }
  appendIgnorable(session, "revert/file-intent", {
    revertSeq: newBoundary ?? -1,
    plan: Object.fromEntries([...plan].map(([key, p]) => [key, { action: p.action, targetBlobSha: p.targetBlobSha, expectedDiskSha: p.expectedDiskSha }]))
  });
  const typedPlan = plan;
  const { outcomes } = await executor.execute({
    sessionId: session.id,
    revertSeq: newBoundary ?? -1,
    plan: typedPlan,
    resolvePath: async (key) => key,
    readDisk: async (key) => readDiskBytes(ctx, key),
    writeDisk: async (path, bytes) => executor.atomicWrite(path, bytes),
    trashFile: async (path) => executor.trash(path, session.id)
  });
  for (const c of conflicts) {
    appendIgnorable(session, "revert/file-conflict", {
      conflictId: randomUUID2(),
      targetKey: c.targetKey,
      displayPath: c.displayPath,
      state: c.state,
      reason: c.reason,
      mode: c.mode,
      boundarySeq: c.boundarySeq,
      spanStartSeq: c.spanStartSeq,
      targetBlobSha: c.targetBlobSha,
      targetAbsent: c.targetAbsent,
      spanPreExisted: c.spanPreExisted,
      sessionCreated: c.sessionCreated,
      preSha: c.preSha,
      postSha: c.postSha,
      currentSha: c.currentSha
    });
  }
  appendIgnorable(session, "revert/file-result", { revertSeq: newBoundary ?? -1, outcomes });
  await recordOutcomes(manifestFor(session.id), session.id, outcomes);
}
async function recordOutcomes(manifest, sessionId, outcomes) {
  for (const [targetKey, outcome] of Object.entries(outcomes)) {
    if (outcome.status !== "restored" && outcome.status !== "trashed") continue;
    const fromSha = outcome.fromSha ?? null;
    const toSha = outcome.toSha ?? null;
    try {
      await manifest.append({
        sessionId,
        toolSeq: Number.MAX_SAFE_INTEGER - 1,
        callId: `revert-${Date.now()}`,
        targetKey,
        displayPath: targetKey,
        operation: "update",
        preExisted: true,
        preStatus: "ok",
        preBlobSha: fromSha,
        postStatus: "ok",
        postBlobSha: toSha,
        isInterleaved: false,
        timestamp: Date.now(),
        source: "plugin-revert"
      });
    } catch (err) {
      diag2(`recordOutcomes: failed to record ${targetKey}: ${String(err)}`);
    }
  }
}
async function applyConflictResolution(ctx, request, executorFor, _blobStore, stateFor, manifestFor) {
  const executor = executorFor(request.sessionId);
  const sessions = ctx.get("sessions");
  const session = sessions?.get?.(request.sessionId);
  if (session === void 0) throw new Error("session not found");
  const conflictEvent = [...session.snapshotEvents()].reverse().find((e) => e.type === "revert/file-conflict" && e.data.conflictId === request.conflictId);
  if (conflictEvent === void 0) throw new Error(`conflict ${request.conflictId} not found`);
  const conflict = conflictEvent.data;
  const state = stateFor(session);
  if (state.boundary !== (conflict.boundarySeq ?? null)) {
    diag2(`file-revert/resolve: stale conflict ${request.conflictId} for ${request.sessionId} (card boundary=${String(conflict.boundarySeq ?? null)}, current=${String(state.boundary)}) \u2014 refusing`);
    throw new Error("conflict is stale: the session boundary moved since this card was shown");
  }
  let resolution = request.resolution;
  let targetBlobSha = null;
  if (resolution === "keep") {
    targetBlobSha = null;
  } else if (resolution === "restore") {
    if (conflict.targetAbsent === true) {
      resolution = "trash";
      targetBlobSha = null;
    } else if (conflict.targetBlobSha !== void 0 && conflict.targetBlobSha !== null) {
      targetBlobSha = conflict.targetBlobSha;
    } else if (conflict.mode === "restore" && conflict.postSha !== null) {
      targetBlobSha = conflict.postSha;
    } else if (conflict.preSha !== null) {
      targetBlobSha = conflict.preSha;
    } else {
      resolution = "trash";
    }
  } else if (resolution === "recreate") {
    targetBlobSha = conflict.targetBlobSha ?? conflict.postSha ?? conflict.preSha;
  } else if (resolution === "trash") {
    resolution = "trash";
  }
  const besidePathOf = async (key) => {
    const slash = key.lastIndexOf("/");
    const dir = slash === -1 ? "." : key.slice(0, slash);
    const base = slash === -1 ? key : key.slice(slash + 1);
    const ts = Date.now();
    let candidate = `${dir}/${base}.pre-revert.${ts}`;
    let counter = 2;
    while (true) {
      try {
        await import("node:fs/promises").then((m) => m.stat(candidate));
        candidate = `${dir}/${base}.pre-revert.${ts}.${counter}`;
        counter += 1;
      } catch {
        break;
      }
    }
    return candidate;
  };
  const outcome = await executor.applyResolution({
    sessionId: request.sessionId,
    targetKey: conflict.targetKey,
    resolution,
    targetBlobSha,
    expectedDiskSha: conflict.currentSha,
    beside: resolution === "recreate" && conflict.currentSha !== null,
    resolvePath: async (key) => resolution === "recreate" && conflict.currentSha !== null ? besidePathOf(key) : key,
    readDisk: async (key) => readDiskBytes(ctx, key),
    writeDisk: async (path, bytes) => executor.atomicWrite(path, bytes),
    trashFile: async (path) => executor.trash(path, request.sessionId)
  });
  if (resolution === "keep" && conflict.currentSha !== null) {
    try {
      const manifest = manifestFor(request.sessionId);
      await manifest.append({
        sessionId: request.sessionId,
        toolSeq: Number.MAX_SAFE_INTEGER - 1,
        callId: `keep-${request.conflictId}`,
        targetKey: conflict.targetKey,
        displayPath: conflict.targetKey,
        operation: "update",
        preExisted: true,
        preStatus: "ok",
        preBlobSha: conflict.currentSha,
        postStatus: "ok",
        postBlobSha: conflict.currentSha,
        isInterleaved: false,
        timestamp: Date.now(),
        source: "user-kept"
      });
    } catch (err) {
      diag2(`keep: failed to record kept state for ${conflict.targetKey}: ${String(err)}`);
    }
  }
  appendIgnorable(session, "revert/file-result", {
    revertSeq: conflict.boundarySeq ?? -1,
    outcomes: { [conflict.targetKey]: outcome }
  });
  if (resolution !== "keep") {
    await recordOutcomes(manifestFor(request.sessionId), request.sessionId, { [conflict.targetKey]: outcome });
  }
  return { outcome };
}
async function recoverUnsealedIntents(ctx, executorFor, manifestFor) {
  try {
    const { readdir: readdir2 } = await import("node:fs/promises");
    const sessions = await readdir2(FILE_HISTORY_ROOT, { withFileTypes: true });
    for (const entry of sessions) {
      if (!entry.isDirectory()) continue;
      const executor = executorFor(entry.name);
      const unsealed = await executor.findUnsealedIntents();
      for (const intent of unsealed) {
        diag2(`recovering unsealed intent ${intent.revertSeq} for ${entry.name}`);
        const plan = new Map(
          Object.entries(intent.plan).map(([key, p]) => {
            const rec = p;
            return [key, { action: rec.action, targetBlobSha: rec.targetBlobSha, expectedDiskSha: rec.expectedDiskSha }];
          })
        );
        const { outcomes } = await executor.execute({
          sessionId: entry.name,
          revertSeq: intent.revertSeq,
          plan,
          resolvePath: async (key) => key,
          readDisk: async (key) => readDiskBytes(ctx, key),
          writeDisk: async (path, bytes) => executor.atomicWrite(path, bytes),
          trashFile: async (path) => executor.trash(path, entry.name)
        });
        await recordOutcomes(manifestFor(entry.name), entry.name, outcomes);
      }
    }
  } catch (err) {
    diag2(`recovery scan failed: ${String(err)}`);
  }
}
async function runGc(manifests, executors, blobStore, ttlMs) {
  const live2 = /* @__PURE__ */ new Set();
  const { readdir: readdir2, readFile: readFile5 } = await import("node:fs/promises");
  const sessions = await readdir2(FILE_HISTORY_ROOT, { withFileTypes: true });
  for (const entry of sessions) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await readFile5(join4(FILE_HISTORY_ROOT, entry.name, "manifest.jsonl"), "utf8");
      for (const line of raw.split("\n")) {
        if (line.length === 0) continue;
        try {
          const rec = JSON.parse(line);
          if (rec.preBlobSha) live2.add(rec.preBlobSha);
          if (rec.postBlobSha) live2.add(rec.postBlobSha);
        } catch {
        }
      }
    } catch {
    }
  }
  for (const e of executors.values()) for (const sha of e.liveShas()) live2.add(sha);
  await blobStore.gc(live2, ttlMs);
}
async function findActiveChildren(ctx, parentId) {
  const sessions = ctx.get("sessions");
  const parent = sessions?.get?.(parentId);
  if (parent === void 0) return [];
  const children = [];
  for (const event of parent.snapshotEvents()) {
    const e = event;
    if (e.type !== "subagent/descriptor") continue;
    if (e.data.childSessionId !== void 0 && ctx.agents.get(e.data.childSessionId) !== void 0) {
      children.push(e.data.childSessionId);
    }
  }
  return children;
}
async function readDiskBytes(ctx, targetKey) {
  const { readFile: readFile5 } = await import("node:fs/promises");
  try {
    return await readFile5(targetKey);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}
function sha256Hex(bytes) {
  return createHash2("sha256").update(bytes).digest("hex");
}
export {
  Config,
  apply,
  inject,
  name
};
