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

import { z } from 'zod'

// ── TraceContext (doc 35 §8.1) ──────────────────────────────────────────────

/** Correlation metadata carried on every orchestration event/log/IPC payload. */
export const traceContextSchema = z.object({
  /** Root query id — one user query spans one trace. */
  traceId: z.string().min(1),
  /** Run id — one subagent run / keeper pass. */
  runId: z.string().min(1),
  /** Persona name (orchestrator, oracle, fixer, context-keeper, …). */
  persona: z.string(),
  /** Parent event seq this event derives from. */
  parentSeq: z.number().int().nonnegative(),
  /** This event's own seq. */
  seq: z.number().int().nonnegative(),
}).strict()

export type TraceContext = z.infer<typeof traceContextSchema>

// ── SubagentReturn (doc 32 §4.0, doc 35 §1.2) ───────────────────────────────

export const provenanceSchema = z.object({
  parentSeqs: z.array(z.number().int().nonnegative()),
  childSessionId: z.string().min(1),
  toolSeqs: z.array(z.number().int().nonnegative()),
}).strict()

export type Provenance = z.infer<typeof provenanceSchema>

/** The structured return contract every subagent reports through. */
export const subagentReturnSchema = z.object({
  /** Files the run changed. */
  changed: z.array(z.string()),
  /** Whether the run verified its own work. */
  verified: z.boolean(),
  /** Files changed but NOT verified (verification gate rejects these). */
  NOT_verified: z.array(z.string()),
  /** Facts the run wants remembered (memory pipeline intake). */
  remember_later: z.array(z.string()),
  /** Provenance for the memory pipeline (living-owner rule). */
  provenance: provenanceSchema,
}).strict()

export type SubagentReturn = z.infer<typeof subagentReturnSchema>

// ── Brief prose event (doc 31 §2, doc 34 I2/I3) ─────────────────────────────

/**
 * The context keeper's prose update. Field ownership (I2): this payload may
 * carry ONLY prose fields (goal/decisions/openThreads) — deterministic fields
 * (filesTouched/blockers/todos) derive strictly from native events and are
 * ignored here. Goal precedence (I3): `basedOnSeq < goalSeq` ⇒ the goal field
 * is rejected by the fold.
 */
export const briefProseUpdatedSchema = z.object({
  goal: z.string().optional(),
  decisions: z.array(z.string()).optional(),
  openThreads: z.array(z.string()).optional(),
  /** The session seq the keeper's input was based on (I3 comparison). */
  basedOnSeq: z.number().int().nonnegative(),
  /** Structural-event count (user/message, turn/end, tool/call, tool/result) at basedOnSeq — seq-based freshness (Oracle amendment 4). */
  basedOnStructuralCount: z.number().int().nonnegative(),
  /** The structural-distance threshold the keeper used — view() classifies freshness with it. */
  structuralDistanceK: z.number().int().positive().optional(),
  /** Route used, e.g. "deepseek/deepseek-v4-flash". */
  model: z.string(),
  /** The prose summary text. */
  text: z.string(),
  /** Always the keeper — the fold rejects other origins. */
  origin: z.literal('context-keeper'),
}).strict()

export type BriefProseUpdated = z.infer<typeof briefProseUpdatedSchema>

// ── LivingBrief projection (doc 33 §4.1) ────────────────────────────────────

/** One decision/constraint/open-thread entry with its source seq. */
export const briefEntrySchema = z.object({
  id: z.string(),
  text: z.string(),
  seq: z.number().int().nonnegative(),
}).strict()

export type BriefEntry = z.infer<typeof briefEntrySchema>

/** One blocker entry (tool failure) with its source seq. */
export const blockerSchema = z.object({
  id: z.string(),
  text: z.string(),
  tool: z.string().optional(),
  seq: z.number().int().nonnegative(),
}).strict()

export type Blocker = z.infer<typeof blockerSchema>

/** Internal fold state of the livingBrief projection unit. */
export interface LivingBriefState {
  goal: string
  decisions: BriefEntry[]
  constraints: BriefEntry[]
  openThreads: BriefEntry[]
  filesTouched: string[]
  blockers: Blocker[]
  phase: string
  prose: {
    text: string
    updatedAt: number
    model: string
    /** The session seq the prose was based on (I3 + seq-based freshness). */
    basedOnSeq: number
    /** Structural-event count at basedOnSeq — seq-based freshness. */
    basedOnStructuralCount: number
    /** The structural-distance threshold used at distillation time. */
    structuralDistanceK: number
  } | null
  /** Last brief/steered seq — I3 goal precedence boundary. */
  goalSeq: number
  /** asOfSeq source — the last folded event's seq. */
  lastEventSeq: number
  /** Fail-safe counter — malformed folds increment, never crash. */
  foldErrors: number
  /** Bounded callId → tool-name map (tool/result needs the caller's name). */
  toolNames: Record<string, string>
  /** Structural-event counter (user/message, turn/end, tool/call, tool/result) — seq-based freshness. */
  structuralCount: number
}

export const livingBriefStateSchema = z.object({
  goal: z.string(),
  decisions: z.array(briefEntrySchema),
  constraints: z.array(briefEntrySchema),
  openThreads: z.array(briefEntrySchema),
  filesTouched: z.array(z.string()),
  blockers: z.array(blockerSchema),
  phase: z.string(),
  prose: z.object({
    text: z.string(),
    updatedAt: z.number(),
    model: z.string(),
    basedOnSeq: z.number().int().nonnegative(),
    basedOnStructuralCount: z.number().int().nonnegative(),
    structuralDistanceK: z.number().int().positive(),
  }).nullable(),
  goalSeq: z.number().int().nonnegative(),
  lastEventSeq: z.number().int().nonnegative(),
  foldErrors: z.number().int().nonnegative(),
  toolNames: z.record(z.string()),
  structuralCount: z.number().int().nonnegative(),
}).strict()

/** The client-visible wire payload (doc 33 §4.1). */
export const livingBriefViewSchema = z.object({
  goal: z.string(),
  decisions: z.array(briefEntrySchema),
  constraints: z.array(briefEntrySchema),
  openThreads: z.array(briefEntrySchema),
  filesTouched: z.array(z.string()),
  blockers: z.array(blockerSchema),
  phase: z.string(),
  prose: z.object({
    text: z.string(),
    updatedAt: z.number(),
    model: z.string(),
    basedOnSeq: z.number().int().nonnegative(),
    basedOnStructuralCount: z.number().int().nonnegative(),
    structuralDistanceK: z.number().int().positive(),
  }).nullable(),
  asOfSeq: z.number().int().nonnegative(),
  freshness: z.union([z.literal('live'), z.literal('cooling'), z.literal('stale')]),
}).strict()

export type LivingBriefView = z.infer<typeof livingBriefViewSchema>

// ── Module augmentations (type-level only; runtime accepts custom types) ────

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Context keeper prose update — folded by the livingBrief unit (I2/I3). */
    'brief/prose-updated': BriefProseUpdated
    /** File-revert batch intent (enpoi-file-revert): durable plan before disk mutation. */
    'revert/file-intent': {
      revertSeq: number
      plan: Record<string, { action: string; targetBlobSha: string | null; expectedDiskSha: string | null }>
    }
    /** File-revert batch terminal marker (enpoi-file-revert): seals the intent. */
    'revert/file-result': {
      revertSeq: number
      outcomes: Record<string, { status: string; fromSha?: string | null; toSha?: string | null; dest?: string; reason?: string }>
    }
    /** File-revert conflict requiring operator resolution (enpoi-file-revert). */
    'revert/file-conflict': {
      conflictId: string
      targetKey: string
      displayPath: string
      state: 'conflict' | 'missing' | 'unavailable'
      reason: string
      mode?: 'revert' | 'restore'
      boundarySeq?: number | null
      spanStartSeq?: number
      targetBlobSha?: string | null
      targetAbsent?: boolean
      spanPreExisted?: boolean
      sessionCreated?: boolean
      preSha: string | null
      postSha: string | null
      currentSha: string | null
    }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    livingBrief: LivingBriefState
  }
  interface SessionProjectionMap {
    livingBrief: LivingBriefView
  }
}

// ── Shared orchestration document reader (doc 74 P1.2) ──────────────────────

/** Profile entry id that owns the shared orchestration document after the settings→Config migration. */
export const ORCHESTRATION_NAMESPACE = 'enpoi-orchestration'

/**
 * Structural face of the settings service used to read the shared document.
 * The 0.1.7+ form service exposes `describe()` keyed by profile entry id; the
 * pre-0.1.7 service exposed `get(ns)` for registered namespaces. The pre-0.1.7
 * descriptor also carried the resolved `value`, so `describe()` alone serves
 * both engines.
 */
export interface SettingsDocumentReader {
  /** Pre-0.1.7 seam: one registered namespace's resolved value. */
  get?: (ns: string) => unknown
  /** 0.1.7+ optional narrow seam: one namespace's descriptor instead of the full set. */
  describeNamespace?: (ns: string) => { ns: string; value?: unknown } | undefined
  /** 0.1.7+ seam: one descriptor per configurable entry, carrying the resolved projected value. */
  describe?: () => ReadonlyArray<{ ns: string; value?: unknown }>
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
export function readSettingsDocument(
  settings: SettingsDocumentReader | undefined,
  ns: string,
): Record<string, unknown> | undefined {
  try {
    const direct = settings?.get?.(ns)
    if (direct !== undefined) {
      return direct !== null && typeof direct === 'object' ? direct as Record<string, unknown> : undefined
    }
    const narrow = settings?.describeNamespace?.(ns)
    if (narrow !== undefined) {
      const value = narrow.value
      return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
    }
    const value = settings?.describe?.().find(entry => entry.ns === ns)?.value
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
  } catch {
    // A settings read is best-effort: callers fail open onto code defaults.
    return undefined
  }
}

/**
 * Read the shared `enpoi-orchestration` document.
 * @param settings - the `settings` service from `ctx.get('settings')`.
 * @returns the document, or undefined when no surface answers.
 */
export function readOrchestrationDocument(
  settings: SettingsDocumentReader | undefined,
): Record<string, unknown> | undefined {
  return readSettingsDocument(settings, ORCHESTRATION_NAMESPACE)
}
