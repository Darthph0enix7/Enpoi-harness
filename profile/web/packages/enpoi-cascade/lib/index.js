// src/index.ts
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
var name = "enpoi-cascade";
function diag(line) {
  try {
    const home = process.env.DSH_HOME ?? process.env.HOME ?? "/tmp";
    const dir = home.endsWith(".dsh") ? home : join(home, ".dsh");
    mkdirSync(join(dir, "logs"), { recursive: true });
    appendFileSync(join(dir, "logs", "enpoi-cascade.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${line}
`);
  } catch {
  }
}
function revertSpan(entries, sessionId, fromSeq) {
  const selected = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    if (entry.kind === "child" && entry.parentId === sessionId && entry.seq > fromSeq) {
      selected.add(entry.id);
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of entries) {
      if (entry.kind !== "child" || selected.has(entry.id)) continue;
      if (selected.has(entry.parentId)) {
        selected.add(entry.id);
        grew = true;
      }
    }
  }
  return entries.filter((entry) => entry.kind === "child" && selected.has(entry.id));
}
async function interruptDescendants(ctx, sessionId, scope) {
  const subagents = ctx.get("subagents");
  const agent = ctx.get("agents")?.get(sessionId);
  if (subagents === void 0 || agent === void 0) return;
  let entries;
  try {
    entries = await subagents.listDescendants(sessionId);
  } catch (error) {
    diag(`descendant enumeration failed for ${sessionId}: ${String(error)}`);
    return;
  }
  const targets = scope.kind === "all" ? entries : revertSpan(entries, sessionId, scope.fromSeq);
  let interrupted = 0;
  for (const entry of targets) {
    if (entry.kind !== "child" || entry.mode !== "continuable") continue;
    try {
      subagents.interrupt(entry.id, { kind: "ancestor", agent });
      interrupted += 1;
    } catch (error) {
      diag(`interrupt of ${entry.id} refused: ${String(error)}`);
    }
  }
  diag(
    `user stop (${scope.kind}) for ${sessionId} \u2014 interrupted ${interrupted} continuable descendant(s) of ${entries.length} enumerated`
  );
}
function apply(ctx) {
  ctx.on("session/event", (session, event) => {
    if (event.type !== "turn/end") return;
    const reason = event.data.reason;
    if (reason.kind !== "aborted") return;
    const cancelCause = reason.reason;
    if (cancelCause === void 0 || cancelCause.kind !== "user") return;
    const intent = cancelCause.intent ?? "stop-all";
    if (intent === "detach") {
      diag(`detach stop for ${session.id} \u2014 continuable descendants keep running`);
      return;
    }
    if (intent === "revert" && cancelCause.revertFromSeq === void 0) {
      diag(`revert stop for ${session.id} carried no revertFromSeq \u2014 no descendants interrupted`);
      return;
    }
    const scope = intent === "revert" ? { kind: "revert", fromSeq: cancelCause.revertFromSeq } : { kind: "all" };
    setTimeout(() => {
      diag(`user stop detected for session ${session.id} \u2014 interrupting continuable descendants (${scope.kind})`);
      void interruptDescendants(ctx, session.id, scope).catch((error) => {
        ctx.logger.warn(`[enpoi-cascade] descendant interrupt failed: ${String(error)}`);
      });
    }, 0);
  });
}
export {
  apply,
  name
};
