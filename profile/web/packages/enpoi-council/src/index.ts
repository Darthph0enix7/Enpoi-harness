/**
 * enpoi-council — Cordis plugin entry point.
 *
 * Exposes `roundtable` (debate council) and `chorus` (ideation council) on the
 * doc-54 core engine: blind formulation, dispute ledger, referee adjudication,
 * evidence broker, state-delta stopping, chair synthesis.
 *
 * Settings-defined councils (`enpoi-orchestration.councils`) extend that set at
 * runtime: each enabled council registers its own `<councilId>` tool, the two
 * management tools (`council_register` / `council_list`) manage the registry,
 * and the `enpoiCouncil` Typert Remote namespace (`remote.ts`) feeds the UI.
 */
import type { Context } from '@deepseek-ai/cordis'
import { mountEnpoiCouncilRemote } from './remote.ts'
import { registerCouncilTools } from './tools.ts'

export const name = 'enpoi-council'
export const inject = ['tools', 'subagents', 'sessionPersistence', 'sessions', 'agents']

export function apply(ctx: Context): void {
  mountEnpoiCouncilRemote(ctx)
  ctx.inject(['tools', 'subagents', 'sessionPersistence', 'sessions', 'agents'], (injected) => {
    registerCouncilTools(injected, ctx)
  })
}
