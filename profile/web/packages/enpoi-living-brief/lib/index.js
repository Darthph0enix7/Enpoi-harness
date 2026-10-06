// src/index.ts
import {
  livingBriefStateSchema,
  livingBriefViewSchema
} from "dsh-enpoi-contracts";
var name = "enpoi-living-brief";
var inject = ["sessionProjections"];
var EDIT_TOOLS = /* @__PURE__ */ new Set(["write", "edit", "str_replace_editor"]);
var MAX_TOOL_NAMES = 200;
var MAX_ENTRIES = 50;
function apply(ctx) {
  ctx.inject(["sessionProjections"], (projectionCtx) => {
    projectionCtx.sessionProjections.register({
      key: "livingBrief",
      stateSchema: livingBriefStateSchema,
      init: () => ({
        goal: "",
        decisions: [],
        constraints: [],
        openThreads: [],
        filesTouched: [],
        blockers: [],
        phase: "idle",
        prose: null,
        goalSeq: 0,
        lastEventSeq: 0,
        foldErrors: 0,
        toolNames: {},
        structuralCount: 0
      }),
      apply: (state, event) => fold(ctx, state, event),
      wire: {
        viewSchema: livingBriefViewSchema,
        view: (state) => view(state)
      },
      stateVersion: 1
    });
  });
}
function fold(ctx, state, event) {
  try {
    switch (event.type) {
      case "turn/start":
        return { ...state, phase: "working", lastEventSeq: event.seq };
      case "turn/end": {
        const kind = event.data.reason.kind;
        return {
          ...state,
          phase: kind === "aborted" ? "aborted" : "idle",
          lastEventSeq: event.seq,
          structuralCount: state.structuralCount + 1
        };
      }
      case "user/message":
        return { ...state, lastEventSeq: event.seq, structuralCount: state.structuralCount + 1 };
      case "tool/call": {
        const data = event.data;
        const toolNames = { ...state.toolNames };
        toolNames[data.callId] = data.name;
        const keys = Object.keys(toolNames);
        if (keys.length > MAX_TOOL_NAMES) {
          for (const key of keys.slice(0, keys.length - MAX_TOOL_NAMES)) delete toolNames[key];
        }
        let filesTouched = state.filesTouched;
        if (EDIT_TOOLS.has(data.name)) {
          const path = extractFilePath(data.arguments);
          if (path !== void 0 && !filesTouched.includes(path)) {
            filesTouched = [...filesTouched, path];
          }
        }
        return {
          ...state,
          toolNames,
          filesTouched,
          lastEventSeq: event.seq,
          structuralCount: state.structuralCount + 1
        };
      }
      case "tool/result": {
        const data = event.data;
        if (data.error === void 0) {
          return { ...state, lastEventSeq: event.seq, structuralCount: state.structuralCount + 1 };
        }
        const callId = data.callId ?? data.message?.source?.callId;
        const tool = callId === void 0 ? void 0 : state.toolNames[callId];
        const blocker = {
          id: `b-${event.seq}`,
          text: `${data.error.name}: ${data.error.code}`,
          ...tool === void 0 ? {} : { tool },
          seq: event.seq
        };
        return {
          ...state,
          blockers: [...state.blockers, blocker].slice(-MAX_ENTRIES),
          lastEventSeq: event.seq,
          structuralCount: state.structuralCount + 1
        };
      }
      case "brief/prose-updated": {
        const data = event.data;
        if (data.origin !== "context-keeper") return { ...state, lastEventSeq: event.seq };
        const next = {
          ...state,
          prose: {
            text: data.text,
            updatedAt: event.time,
            model: data.model,
            basedOnSeq: data.basedOnSeq,
            // Legacy keeper events predate the structural watermark; 0 keeps
            // the prose honestly stale until the next keeper update.
            basedOnStructuralCount: data.basedOnStructuralCount ?? 0,
            structuralDistanceK: data.structuralDistanceK ?? 24
          },
          lastEventSeq: event.seq
        };
        if (data.goal !== void 0 && data.basedOnSeq >= state.goalSeq) {
          next.goal = data.goal;
        }
        if (data.decisions !== void 0) {
          next.decisions = entries(data.decisions, event.seq);
        }
        if (data.openThreads !== void 0) {
          next.openThreads = entries(data.openThreads, event.seq);
        }
        return next;
      }
      default:
        return state;
    }
  } catch (error) {
    ctx.logger.warn(`enpoi-living-brief: fold anomaly on ${event.type} seq ${event.seq}: ${String(error)}`);
    return { ...state, foldErrors: state.foldErrors + 1, lastEventSeq: event.seq };
  }
}
function entries(texts, seq) {
  return texts.slice(-MAX_ENTRIES).map((text, i) => ({ id: `e-${seq}-${i}`, text, seq }));
}
function extractFilePath(argumentsJson) {
  try {
    const parsed = JSON.parse(argumentsJson);
    return typeof parsed.file_path === "string" && parsed.file_path.length > 0 ? parsed.file_path : void 0;
  } catch {
    return void 0;
  }
}
function view(state) {
  const freshness = state.prose === null ? "stale" : state.structuralCount - state.prose.basedOnStructuralCount <= state.prose.structuralDistanceK ? "live" : state.structuralCount - state.prose.basedOnStructuralCount <= state.prose.structuralDistanceK * 2 ? "cooling" : "stale";
  return {
    goal: state.goal,
    decisions: state.decisions,
    constraints: state.constraints,
    openThreads: state.openThreads,
    filesTouched: state.filesTouched,
    blockers: state.blockers,
    phase: state.phase,
    prose: state.prose,
    asOfSeq: state.lastEventSeq,
    freshness
  };
}
export {
  apply,
  fold,
  inject,
  name,
  view
};
