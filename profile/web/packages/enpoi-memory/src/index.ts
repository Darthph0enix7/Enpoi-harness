/**
 * enpoi-memory — Cordis plugin: boot reconcile and the memory tools. Memory is
 * tools-driven (on demand, via memory_search) with no passive injection: an
 * injected block lands as an extra step of the running turn, costs a model
 * call, and re-emits the system prompt for nothing. Exposes no service —
 * keeper/dispatcher/CLI open the same DB file through their own connections
 * (WAL + BEGIN IMMEDIATE serialize).
 */
import type { Context } from '@deepseek-ai/cordis'
import { openMemoryDb } from './db'
import { makePipeline } from './pipeline'
import { registerMemoryTools } from './tools'

/** Shared DB/pipeline access for sibling plugins (keeper, dispatcher, CLI). */
export { openMemoryDb } from './db'
export { makePipeline } from './pipeline'

export const name = 'enpoi-memory'
export const inject = ['tools']

export function apply(ctx: Context): void {
  const db = openMemoryDb()
  const pipeline = makePipeline(db)

  // Boot reconciliation (I10, doc 35 4.1): any crash-leftover tentative → orphaned.
  void pipeline.reconcileBoot().then(n => {
    if (n > 0) ctx.logger?.warn(`enpoi-memory: boot reconciled ${n} tentative claim(s) → orphaned_cancelled`)
  })

  registerMemoryTools(ctx, db, pipeline)

}
