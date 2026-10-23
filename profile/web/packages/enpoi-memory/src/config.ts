/**
 * enpoi-memory — plugin configuration (durable-facts capture + workspace
 * scoping). Values are resolved once per mount from the schema-normalized
 * plugin config; every read clamps defensively so a direct `apply()` call in a
 * test (no Schema pass) still gets the documented bounds.
 *
 * @module dsh-enpoi-memory/config
 */

/** Plugin config: compaction-fact capture and recall scoping. */
export interface MemoryConfig {
  /** Capture the `## Durable Facts` section of model-written compaction summaries. */
  compactionFacts: boolean
  /** Also capture facts from subagent child sessions; off by default (children are scratch work). */
  compactionFactsIncludeChildSessions: boolean
  /** Maximum facts captured from one compaction (clamped 1–40). */
  compactionFactsMax: number
  /** Token-set Jaccard threshold above which a candidate is a near-duplicate (clamped 0.5–1). */
  compactionFactsNearDuplicate: number
  /** Restrict `origin = 'compaction'` rows in `memory_search` to the caller's workspace cwd. */
  scopeCompactionFactsToWorkspace: boolean
}

/** Documented defaults. */
export const MEMORY_CONFIG_DEFAULTS: MemoryConfig = {
  compactionFacts: true,
  compactionFactsIncludeChildSessions: false,
  compactionFactsMax: 12,
  compactionFactsNearDuplicate: 0.8,
  scopeCompactionFactsToWorkspace: true,
}

/** Clamp one number into an inclusive range, falling back on non-numbers. */
function clamp(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && !Number.isNaN(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

/**
 * Resolve a (possibly partial or unvalidated) plugin config into the effective
 * one. Never throws: a missing or malformed field keeps its default.
 * @param config - the raw config the host passed to `apply`.
 * @returns the effective config with every bound applied.
 */
export function resolveMemoryConfig(config: Partial<MemoryConfig> | undefined): MemoryConfig {
  const d = MEMORY_CONFIG_DEFAULTS
  return {
    compactionFacts: typeof config?.compactionFacts === 'boolean' ? config.compactionFacts : d.compactionFacts,
    compactionFactsIncludeChildSessions: typeof config?.compactionFactsIncludeChildSessions === 'boolean'
      ? config.compactionFactsIncludeChildSessions
      : d.compactionFactsIncludeChildSessions,
    compactionFactsMax: Math.trunc(clamp(config?.compactionFactsMax, d.compactionFactsMax, 1, 40)),
    compactionFactsNearDuplicate: clamp(config?.compactionFactsNearDuplicate, d.compactionFactsNearDuplicate, 0.5, 1),
    scopeCompactionFactsToWorkspace: typeof config?.scopeCompactionFactsToWorkspace === 'boolean'
      ? config.scopeCompactionFactsToWorkspace
      : d.scopeCompactionFactsToWorkspace,
  }
}
