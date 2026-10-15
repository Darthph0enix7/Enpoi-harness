// src/index.ts
import Schema from "@deepseek-ai/schemastery";
import { mkdirSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
var name = "enpoi-skin-guard";
var inject = [];
var DEFAULT_SKIN = process.env.DSH_GUARD_SKIN ?? "summer-liquid-glass";
var DEFAULT_POLL_MS = 3e4;
var RECHECK_DELAY_MS = 5e3;
var DEBOUNCE_MS = 250;
var Config = Schema.object({
  skin: Schema.string().default(DEFAULT_SKIN),
  pollMs: Schema.natural().default(DEFAULT_POLL_MS)
});
function defaultStatePath() {
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "skin-center-active.json");
}
function restoreIfNull(statePath, skin) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return false;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return false;
  const record = doc;
  if (record.active !== null && record.active !== void 0) return false;
  record.active = skin;
  record.initialized = true;
  try {
    const tmp = `${statePath}.guard-${process.pid}`;
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}
`, "utf8");
    renameSync(tmp, statePath);
  } catch (error) {
    console.warn(`[enpoi-skin-guard] restore write failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  console.log(`[enpoi-skin-guard] restored active skin to ${skin}`);
  return true;
}
function apply(ctx, config = {}) {
  const skin = config.skin ?? DEFAULT_SKIN;
  const pollMs = config.pollMs ?? DEFAULT_POLL_MS;
  const statePath = defaultStatePath();
  const stateDir = dirname(statePath);
  const stateName = basename(statePath);
  console.log(`[enpoi-skin-guard] mounted (state=${statePath}, skin=${skin})`);
  restoreIfNull(statePath, skin);
  const recheck = setTimeout(() => restoreIfNull(statePath, skin), RECHECK_DELAY_MS);
  recheck.unref();
  let watcher;
  let debounce;
  try {
    watcher = watch(stateDir, { persistent: false }, (_event, filename) => {
      if (filename !== null && filename !== stateName) return;
      if (debounce !== void 0) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = void 0;
        restoreIfNull(statePath, skin);
      }, DEBOUNCE_MS);
      debounce.unref();
    });
    watcher.on("error", (error) => {
      console.warn(`[enpoi-skin-guard] watcher error: ${error.message}`);
    });
  } catch (error) {
    console.warn(`[enpoi-skin-guard] watch unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const poll = setInterval(() => restoreIfNull(statePath, skin), pollMs);
  poll.unref();
  ctx.on("dispose", () => {
    clearTimeout(recheck);
    if (debounce !== void 0) clearTimeout(debounce);
    clearInterval(poll);
    watcher?.close();
  });
}
export {
  Config,
  apply,
  defaultStatePath,
  inject,
  name,
  restoreIfNull
};
