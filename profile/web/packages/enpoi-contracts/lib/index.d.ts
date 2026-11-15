/**
 * Enpoi Harness orchestration contracts — the shared zod schemas and type
 * augmentations for the orchestration event vocabulary (doc 33 §4, doc 34).
 *
 * This is a plain TS leaf package: NO Cordis service, NO runtime plugin.
 * Runtime events are parsed once at the ingest boundary with these schemas,
 * then trusted through the fold (roundtable decision: zod for runtime data,
 * schemastery reserved for Cordis plugin Config definitions).
 *
 * @module dsh-enpoi-contracts
 */
import { z } from 'zod';
/** Correlation metadata carried on every orchestration event/log/IPC payload. */
export declare const traceContextSchema: z.ZodObject<{
    /** Root query id — one user query spans one trace. */
    traceId: z.ZodString;
    /** Run id — one subagent run / keeper pass. */
    runId: z.ZodString;
    /** Persona name (orchestrator, oracle, fixer, context-keeper, …). */
    persona: z.ZodString;
    /** Parent event seq this event derives from. */
    parentSeq: z.ZodNumber;
    /** This event's own seq. */
    seq: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
    traceId: string;
    runId: string;
    persona: string;
    parentSeq: number;
    seq: number;
}, {
    traceId: string;
    runId: string;
    persona: string;
    parentSeq: number;
    seq: number;
}>;
export type TraceContext = z.infer<typeof traceContextSchema>;
export declare const provenanceSchema: z.ZodObject<{
    parentSeqs: z.ZodArray<z.ZodNumber, "many">;
    childSessionId: z.ZodString;
    toolSeqs: z.ZodArray<z.ZodNumber, "many">;
}, "strict", z.ZodTypeAny, {
    parentSeqs: number[];
    childSessionId: string;
    toolSeqs: number[];
}, {
    parentSeqs: number[];
    childSessionId: string;
    toolSeqs: number[];
}>;
export type Provenance = z.infer<typeof provenanceSchema>;
/** The structured return contract every subagent reports through. */
export declare const subagentReturnSchema: z.ZodObject<{
    /** Files the run changed. */
    changed: z.ZodArray<z.ZodString, "many">;
    /** Whether the run verified its own work. */
    verified: z.ZodBoolean;
    /** Files changed but NOT verified (verification gate rejects these). */
    NOT_verified: z.ZodArray<z.ZodString, "many">;
    /** Facts the run wants remembered (memory pipeline intake). */
    remember_later: z.ZodArray<z.ZodString, "many">;
    /** Provenance for the memory pipeline (living-owner rule). */
    provenance: z.ZodObject<{
        parentSeqs: z.ZodArray<z.ZodNumber, "many">;
        childSessionId: z.ZodString;
        toolSeqs: z.ZodArray<z.ZodNumber, "many">;
    }, "strict", z.ZodTypeAny, {
        parentSeqs: number[];
        childSessionId: string;
        toolSeqs: number[];
    }, {
        parentSeqs: number[];
        childSessionId: string;
        toolSeqs: number[];
    }>;
}, "strict", z.ZodTypeAny, {
    changed: string[];
    verified: boolean;
    NOT_verified: string[];
    remember_later: string[];
    provenance: {
        parentSeqs: number[];
        childSessionId: string;
        toolSeqs: number[];
    };
}, {
    changed: string[];
    verified: boolean;
    NOT_verified: string[];
    remember_later: string[];
    provenance: {
        parentSeqs: number[];
        childSessionId: string;
        toolSeqs: number[];
    };
}>;
export type SubagentReturn = z.infer<typeof subagentReturnSchema>;
/**
 * The context keeper's prose update. Field ownership (I2): this payload may
 * carry ONLY prose fields (goal/decisions/openThreads) — deterministic fields
 * (filesTouched/blockers/todos) derive strictly from native events and are
 * ignored here. Goal precedence (I3): `basedOnSeq < goalSeq` ⇒ the goal field
 * is rejected by the fold.
 */
export declare const briefProseUpdatedSchema: z.ZodObject<{
    goal: z.ZodOptional<z.ZodString>;
    decisions: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    openThreads: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    /** The session seq the keeper's input was based on (I3 comparison). */
    basedOnSeq: z.ZodNumber;
    /** Structural-event count (user/message, turn/end, tool/call, tool/result) at basedOnSeq — seq-based freshness (Oracle amendment 4). */
    basedOnStructuralCount: z.ZodNumber;
    /** The structural-distance threshold the keeper used — view() classifies freshness with it. */
    structuralDistanceK: z.ZodOptional<z.ZodNumber>;
    /** Route used, e.g. "deepseek/deepseek-v4-flash". */
    model: z.ZodString;
    /** The prose summary text. */
    text: z.ZodString;
    /** Always the keeper — the fold rejects other origins. */
    origin: z.ZodLiteral<"context-keeper">;
}, "strict", z.ZodTypeAny, {
    basedOnSeq: number;
    basedOnStructuralCount: number;
    model: string;
    text: string;
    origin: "context-keeper";
    goal?: string | undefined;
    decisions?: string[] | undefined;
    openThreads?: string[] | undefined;
    structuralDistanceK?: number | undefined;
}, {
    basedOnSeq: number;
    basedOnStructuralCount: number;
    model: string;
    text: string;
    origin: "context-keeper";
    goal?: string | undefined;
    decisions?: string[] | undefined;
    openThreads?: string[] | undefined;
    structuralDistanceK?: number | undefined;
}>;
export type BriefProseUpdated = z.infer<typeof briefProseUpdatedSchema>;
/** One decision/constraint/open-thread entry with its source seq. */
export declare const briefEntrySchema: z.ZodObject<{
    id: z.ZodString;
    text: z.ZodString;
    seq: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
    seq: number;
    text: string;
    id: string;
}, {
    seq: number;
    text: string;
    id: string;
}>;
export type BriefEntry = z.infer<typeof briefEntrySchema>;
/** One blocker entry (tool failure) with its source seq. */
export declare const blockerSchema: z.ZodObject<{
    id: z.ZodString;
    text: z.ZodString;
    tool: z.ZodOptional<z.ZodString>;
    seq: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
    seq: number;
    text: string;
    id: string;
    tool?: string | undefined;
}, {
    seq: number;
    text: string;
    id: string;
    tool?: string | undefined;
}>;
export type Blocker = z.infer<typeof blockerSchema>;
/** Internal fold state of the livingBrief projection unit. */
export interface LivingBriefState {
    goal: string;
    decisions: BriefEntry[];
    constraints: BriefEntry[];
    openThreads: BriefEntry[];
    filesTouched: string[];
    blockers: Blocker[];
    phase: string;
    prose: {
        text: string;
        updatedAt: number;
        model: string;
        /** The session seq the prose was based on (I3 + seq-based freshness). */
        basedOnSeq: number;
        /** Structural-event count at basedOnSeq — seq-based freshness. */
        basedOnStructuralCount: number;
        /** The structural-distance threshold used at distillation time. */
        structuralDistanceK: number;
    } | null;
    /** Last brief/steered seq — I3 goal precedence boundary. */
    goalSeq: number;
    /** asOfSeq source — the last folded event's seq. */
    lastEventSeq: number;
    /** Fail-safe counter — malformed folds increment, never crash. */
    foldErrors: number;
    /** Bounded callId → tool-name map (tool/result needs the caller's name). */
    toolNames: Record<string, string>;
    /** Structural-event counter (user/message, turn/end, tool/call, tool/result) — seq-based freshness. */
    structuralCount: number;
}
export declare const livingBriefStateSchema: z.ZodObject<{
    goal: z.ZodString;
    decisions: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        seq: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        seq: number;
        text: string;
        id: string;
    }, {
        seq: number;
        text: string;
        id: string;
    }>, "many">;
    constraints: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        seq: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        seq: number;
        text: string;
        id: string;
    }, {
        seq: number;
        text: string;
        id: string;
    }>, "many">;
    openThreads: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        seq: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        seq: number;
        text: string;
        id: string;
    }, {
        seq: number;
        text: string;
        id: string;
    }>, "many">;
    filesTouched: z.ZodArray<z.ZodString, "many">;
    blockers: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        tool: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        seq: number;
        text: string;
        id: string;
        tool?: string | undefined;
    }, {
        seq: number;
        text: string;
        id: string;
        tool?: string | undefined;
    }>, "many">;
    phase: z.ZodString;
    prose: z.ZodNullable<z.ZodObject<{
        text: z.ZodString;
        updatedAt: z.ZodNumber;
        model: z.ZodString;
        basedOnSeq: z.ZodNumber;
        basedOnStructuralCount: z.ZodNumber;
        structuralDistanceK: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        basedOnSeq: number;
        basedOnStructuralCount: number;
        structuralDistanceK: number;
        model: string;
        text: string;
        updatedAt: number;
    }, {
        basedOnSeq: number;
        basedOnStructuralCount: number;
        structuralDistanceK: number;
        model: string;
        text: string;
        updatedAt: number;
    }>>;
    goalSeq: z.ZodNumber;
    lastEventSeq: z.ZodNumber;
    foldErrors: z.ZodNumber;
    toolNames: z.ZodRecord<z.ZodString, z.ZodString>;
    structuralCount: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
    goal: string;
    decisions: {
        seq: number;
        text: string;
        id: string;
    }[];
    openThreads: {
        seq: number;
        text: string;
        id: string;
    }[];
    constraints: {
        seq: number;
        text: string;
        id: string;
    }[];
    filesTouched: string[];
    blockers: {
        seq: number;
        text: string;
        id: string;
        tool?: string | undefined;
    }[];
    phase: string;
    prose: {
        basedOnSeq: number;
        basedOnStructuralCount: number;
        structuralDistanceK: number;
        model: string;
        text: string;
        updatedAt: number;
    } | null;
    goalSeq: number;
    lastEventSeq: number;
    foldErrors: number;
    toolNames: Record<string, string>;
    structuralCount: number;
}, {
    goal: string;
    decisions: {
        seq: number;
        text: string;
        id: string;
    }[];
    openThreads: {
        seq: number;
        text: string;
        id: string;
    }[];
    constraints: {
        seq: number;
        text: string;
        id: string;
    }[];
    filesTouched: string[];
    blockers: {
        seq: number;
        text: string;
        id: string;
        tool?: string | undefined;
    }[];
    phase: string;
    prose: {
        basedOnSeq: number;
        basedOnStructuralCount: number;
        structuralDistanceK: number;
        model: string;
        text: string;
        updatedAt: number;
    } | null;
    goalSeq: number;
    lastEventSeq: number;
    foldErrors: number;
    toolNames: Record<string, string>;
    structuralCount: number;
}>;
/** The client-visible wire payload (doc 33 §4.1). */
export declare const livingBriefViewSchema: z.ZodObject<{
    goal: z.ZodString;
    decisions: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        seq: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        seq: number;
        text: string;
        id: string;
    }, {
        seq: number;
        text: string;
        id: string;
    }>, "many">;
    constraints: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        seq: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        seq: number;
        text: string;
        id: string;
    }, {
        seq: number;
        text: string;
        id: string;
    }>, "many">;
    openThreads: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        seq: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        seq: number;
        text: string;
        id: string;
    }, {
        seq: number;
        text: string;
        id: string;
    }>, "many">;
    filesTouched: z.ZodArray<z.ZodString, "many">;
    blockers: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        tool: z.ZodOptional<z.ZodString>;
        seq: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        seq: number;
        text: string;
        id: string;
        tool?: string | undefined;
    }, {
        seq: number;
        text: string;
        id: string;
        tool?: string | undefined;
    }>, "many">;
    phase: z.ZodString;
    prose: z.ZodNullable<z.ZodObject<{
        text: z.ZodString;
        updatedAt: z.ZodNumber;
        model: z.ZodString;
        basedOnSeq: z.ZodNumber;
        basedOnStructuralCount: z.ZodNumber;
        structuralDistanceK: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        basedOnSeq: number;
        basedOnStructuralCount: number;
        structuralDistanceK: number;
        model: string;
        text: string;
        updatedAt: number;
    }, {
        basedOnSeq: number;
        basedOnStructuralCount: number;
        structuralDistanceK: number;
        model: string;
        text: string;
        updatedAt: number;
    }>>;
    asOfSeq: z.ZodNumber;
    freshness: z.ZodUnion<[z.ZodLiteral<"live">, z.ZodLiteral<"cooling">, z.ZodLiteral<"stale">]>;
}, "strict", z.ZodTypeAny, {
    goal: string;
    decisions: {
        seq: number;
        text: string;
        id: string;
    }[];
    openThreads: {
        seq: number;
        text: string;
        id: string;
    }[];
    constraints: {
        seq: number;
        text: string;
        id: string;
    }[];
    filesTouched: string[];
    blockers: {
        seq: number;
        text: string;
        id: string;
        tool?: string | undefined;
    }[];
    phase: string;
    prose: {
        basedOnSeq: number;
        basedOnStructuralCount: number;
        structuralDistanceK: number;
        model: string;
        text: string;
        updatedAt: number;
    } | null;
    asOfSeq: number;
    freshness: "live" | "cooling" | "stale";
}, {
    goal: string;
    decisions: {
        seq: number;
        text: string;
        id: string;
    }[];
    openThreads: {
        seq: number;
        text: string;
        id: string;
    }[];
    constraints: {
        seq: number;
        text: string;
        id: string;
    }[];
    filesTouched: string[];
    blockers: {
        seq: number;
        text: string;
        id: string;
        tool?: string | undefined;
    }[];
    phase: string;
    prose: {
        basedOnSeq: number;
        basedOnStructuralCount: number;
        structuralDistanceK: number;
        model: string;
        text: string;
        updatedAt: number;
    } | null;
    asOfSeq: number;
    freshness: "live" | "cooling" | "stale";
}>;
export type LivingBriefView = z.infer<typeof livingBriefViewSchema>;
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        /** Context keeper prose update — folded by the livingBrief unit (I2/I3). */
        'brief/prose-updated': BriefProseUpdated;
        /** File-revert batch intent (enpoi-file-revert): durable plan before disk mutation. */
        'revert/file-intent': {
            revertSeq: number;
            plan: Record<string, {
                action: string;
                targetBlobSha: string | null;
                expectedDiskSha: string | null;
            }>;
        };
        /** File-revert batch terminal marker (enpoi-file-revert): seals the intent. */
        'revert/file-result': {
            revertSeq: number;
            outcomes: Record<string, {
                status: string;
                fromSha?: string | null;
                toSha?: string | null;
                dest?: string;
                reason?: string;
            }>;
        };
        /** File-revert conflict requiring operator resolution (enpoi-file-revert). */
        'revert/file-conflict': {
            conflictId: string;
            targetKey: string;
            displayPath: string;
            state: 'conflict' | 'missing' | 'unavailable';
            reason: string;
            mode?: 'revert' | 'restore';
            boundarySeq?: number | null;
            spanStartSeq?: number;
            targetBlobSha?: string | null;
            targetAbsent?: boolean;
            spanPreExisted?: boolean;
            sessionCreated?: boolean;
            preSha: string | null;
            postSha: string | null;
            currentSha: string | null;
        };
    }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionStateMap {
        livingBrief: LivingBriefState;
    }
    interface SessionProjectionMap {
        livingBrief: LivingBriefView;
    }
}
/** Profile entry id that owns the shared orchestration document after the settings→Config migration. */
export declare const ORCHESTRATION_NAMESPACE = "enpoi-orchestration";
/**
 * Structural face of the settings service used to read the shared document.
 * The 0.1.7+ form service exposes `describe()` keyed by profile entry id; the
 * pre-0.1.7 service exposed `get(ns)` for registered namespaces. The pre-0.1.7
 * descriptor also carried the resolved `value`, so `describe()` alone serves
 * both engines.
 */
export interface SettingsDocumentReader {
    /** Pre-0.1.7 seam: one registered namespace's resolved value. */
    get?: (ns: string) => unknown;
    /** 0.1.7+ optional narrow seam: one namespace's descriptor instead of the full set. */
    describeNamespace?: (ns: string) => {
        ns: string;
        value?: unknown;
    } | undefined;
    /** 0.1.7+ seam: one descriptor per configurable entry, carrying the resolved projected value. */
    describe?: () => ReadonlyArray<{
        ns: string;
        value?: unknown;
    }>;
}
/**
 * Read one settings document from whichever settings surface the engine
 * exposes: `get(ns)` when a pre-0.1.7 service still offers it, a narrow
 * `describeNamespace(ns)` when the service offers it, otherwise the
 * `describe()` value of the entry with the same id. The 0.1.7+ service
 * memoizes its full describe per settings generation, so the fallback shares
 * one projection with every other reader instead of rebuilding it per call.
 * Both engines answer the live document, so callers keep their fail-open
 * defaults.
 * @param settings - the `settings` service from `ctx.get('settings')`.
 * @param ns - profile entry id (0.1.7+) / registered namespace (pre-0.1.7).
 * @returns the document, or undefined when no surface answers.
 */
export declare function readSettingsDocument(settings: SettingsDocumentReader | undefined, ns: string): Record<string, unknown> | undefined;
/**
 * Read the shared `enpoi-orchestration` document.
 * @param settings - the `settings` service from `ctx.get('settings')`.
 * @returns the document, or undefined when no surface answers.
 */
export declare function readOrchestrationDocument(settings: SettingsDocumentReader | undefined): Record<string, unknown> | undefined;
/**
 * Explicit operator tool denies for one trusted role id, read from the live
 * orchestration document. Spawn paths whose child carries the parent preset
 * (Oracle, evidence research, council seats) merge these into the child tool
 * filter. The role argument is the trusted spawn role, never a descriptor label
 * or inherited parent preset. An explicit `run_code` deny is included: core
 * `tools.restrict()` accepts the reserved transport in `deny` and removes it
 * from that child's scope, while PTC remains the preset's presentation choice
 * for scopes that do not deny it.
 * @param document - the live `enpoi-orchestration` document, if readable.
 * @param role - trusted spawn role id.
 * @returns deny names for the role's explicit tool rows.
 */
export declare function configuredRoleToolDenies(document: Record<string, unknown> | undefined, role: string): string[];
