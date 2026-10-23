/**
 * enpoi-memory — Cordis plugin: boot reconcile, the memory tools, and the
 * compaction durable-facts subscriber. Memory is tools-driven (on demand, via
 * memory_search) with no passive injection: an injected block lands as an
 * extra step of the running turn, costs a model call, and re-emits the system
 * prompt for nothing. Exposes no service — keeper/dispatcher/CLI open the same
 * DB file through their own connections (WAL + BEGIN IMMEDIATE serialize).
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { resolveMemoryConfig, type MemoryConfig } from './config'
import { registerCompactionFacts } from './compaction-facts'
import { openMemoryDb } from './db'
import { makePipeline } from './pipeline'
import { registerMemoryTools } from './tools'

/** Shared DB/pipeline access for sibling plugins (keeper, dispatcher, CLI). */
export { openMemoryDb } from './db'
export { makePipeline } from './pipeline'
export { resolveMemoryConfig, MEMORY_CONFIG_DEFAULTS, type MemoryConfig } from './config'

export const name = 'enpoi-memory'
export const inject = ['tools']

/** Plugin config: compaction-fact capture and recall scoping. */
export type Config = MemoryConfig

/** Runtime schema (defaults mirror {@link MEMORY_CONFIG_DEFAULTS}). */
export const Config: Schema<Config> = Schema.object({
  compactionFacts: Schema.boolean().default(true),
  compactionFactsIncludeChildSessions: Schema.boolean().default(false),
  compactionFactsMax: Schema.natural().min(1).max(40).default(12),
  compactionFactsNearDuplicate: Schema.number().step(0.01).min(0.5).max(1).default(0.8),
  scopeCompactionFactsToWorkspace: Schema.boolean().default(true),
})

export function apply(ctx: Context, config: Partial<MemoryConfig> = {}): void {
  const cfg = resolveMemoryConfig(config)
  const db = openMemoryDb()
  const pipeline = makePipeline(db)

  // Boot reconciliation (I10, doc 35 4.1): any crash-leftover tentative → orphaned.
  void pipeline.reconcileBoot().then(n => {
    if (n > 0) ctx.logger?.warn(`enpoi-memory: boot reconciled ${n} tentative claim(s) → orphaned_cancelled`)
  })

  registerMemoryTools(ctx, db, pipeline, cfg)

  // Durable facts from compaction checkpoints (L2). The disposer drops every
  // held summary and stops scheduled writes; a late write after plugin
  // disposal must never land.
  if (cfg.compactionFacts) ctx.effect(() => registerCompactionFacts(ctx, db, pipeline, cfg))
}
