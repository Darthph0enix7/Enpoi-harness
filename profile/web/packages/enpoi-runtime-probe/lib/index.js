// src/index.ts
import Schema from "@deepseek-ai/schemastery";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
var name = "enpoi-runtime-probe";
var inject = [];
var DEFAULT_FIRST_PROBE_DELAY_MS = 2e3;
var DEFAULT_SECOND_PROBE_DELAY_MS = 3e4;
var Config = Schema.object({
  firstProbeDelayMs: Schema.natural().default(DEFAULT_FIRST_PROBE_DELAY_MS),
  secondProbeDelayMs: Schema.natural().default(DEFAULT_SECOND_PROBE_DELAY_MS)
});
function diag(line) {
  try {
    const home = process.env.DSH_HOME ?? process.env.HOME ?? "/tmp";
    const dir = join(home.endsWith(".dsh") ? home : join(home, ".dsh"), "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "enpoi-runtime-probe.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${line}
`);
  } catch {
  }
}
function apply(ctx, config = {}) {
  setTimeout(() => {
    probe(ctx);
  }, config.firstProbeDelayMs ?? DEFAULT_FIRST_PROBE_DELAY_MS);
  setTimeout(() => {
    probe(ctx);
  }, config.secondProbeDelayMs ?? DEFAULT_SECOND_PROBE_DELAY_MS);
}
function probe(ctx) {
  const results = [];
  const projections = ctx.get("sessionProjections");
  if (projections === void 0) {
    ctx.logger.warn("[enpoi-runtime-probe] seam sessionProjections ABSENT \u2014 living-brief projection disabled (per-seam degradation)");
    results.push("sessionProjections: ABSENT");
  } else if (typeof projections.register !== "function") {
    ctx.logger.warn("[enpoi-runtime-probe] seam sessionProjections.register MISSING \u2014 living-brief projection disabled (per-seam degradation)");
    results.push("sessionProjections.register: MISSING");
  } else {
    results.push("sessionProjections: OK");
  }
  const subagents = ctx.get("subagents");
  if (subagents === void 0) {
    ctx.logger.warn("[enpoi-runtime-probe] seam subagents ABSENT \u2014 Phase 2 oracle/worker dispatch blocked (per-seam degradation)");
    results.push("subagents: ABSENT");
  } else if (typeof subagents.startContinuable !== "function") {
    ctx.logger.warn("[enpoi-runtime-probe] seam subagents.startContinuable MISSING \u2014 Phase 2 oracle blocked (per-seam degradation)");
    results.push("subagents.startContinuable: MISSING");
  } else {
    results.push("subagents.startContinuable: OK");
  }
  const llm = ctx.get("llm");
  if (llm === void 0 || typeof llm.stream !== "function") {
    ctx.logger.warn("[enpoi-runtime-probe] seam llm.stream ABSENT \u2014 context keeper disabled (per-seam degradation)");
    results.push("llm.stream: ABSENT");
  } else {
    results.push("llm.stream: OK");
  }
  const agents = ctx.get("agents");
  if (agents === void 0) {
    ctx.logger.warn("[enpoi-runtime-probe] seam agents ABSENT \u2014 per-persona hot-swap unavailable (per-seam degradation; session default model used)");
    results.push("agents: ABSENT");
  } else {
    results.push("agents: OK");
  }
  ctx.logger.info(`[enpoi-runtime-probe] seams: ${results.join(" \xB7 ")}`);
  diag(`seams: ${results.join(" \xB7 ")}`);
}
export {
  Config,
  apply,
  inject,
  name
};
