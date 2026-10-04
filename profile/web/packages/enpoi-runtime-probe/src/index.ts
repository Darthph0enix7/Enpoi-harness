/**
 * Enpoi Harness Runtime Probe — the startup seam tripwire (doc 35 §11.2).
 *
 * Verifies the three pinned engine seams at boot in <10ms and logs loudly.
 * Per-seam degradation (roundtable + Oracle): a missing seam disables only
 * the Enpoi extension that needs it — the harness keeps running vanilla.
 * Never hard-crashes.
 *
 * @module dsh-enpoi-runtime-probe
 */

import type { Context } from '@deepseek-ai/cordis'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'enpoi-runtime-probe'

/** Optional-only seam reads: every capability is probed via `ctx.get`. */
export const inject: string[] = []

/** File diagnostics — the Cordis logger only buffers (no console sink). */
function diag(line: string): void {
  try {
    const home = process.env.DSH_HOME ?? process.env.HOME ?? '/tmp'
    const dir = join(home.endsWith('.dsh') ? home : join(home, '.dsh'), 'logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'enpoi-runtime-probe.log'), `${new Date().toISOString()} ${line}\n`)
  } catch {
    // diagnostics must never break the probe
  }
}

export function apply(ctx: Context): void {
  // Defer the checks: services (llm, subagents, agents) register after the
  // probe mounts. A short delay makes the tripwire see the settled tree.
  setTimeout(() => {
    probe(ctx)
  }, 2000)
  // Second pass: `subagents` is session-lazy (created when a session mounts
  // the delegation group) — re-check after sessions have had time to exist.
  setTimeout(() => {
    probe(ctx)
  }, 30_000)
}

function probe(ctx: Context): void {
  const results: string[] = []

  // Seam 1: sessionProjections (living-brief projection).
  const projections = ctx.get('sessionProjections')
  if (projections === undefined) {
    ctx.logger.warn('[enpoi-runtime-probe] seam sessionProjections ABSENT — living-brief projection disabled (per-seam degradation)')
    results.push('sessionProjections: ABSENT')
  } else if (typeof projections.register !== 'function') {
    ctx.logger.warn('[enpoi-runtime-probe] seam sessionProjections.register MISSING — living-brief projection disabled (per-seam degradation)')
    results.push('sessionProjections.register: MISSING')
  } else {
    results.push('sessionProjections: OK')
  }

  // Seam 2: subagents (Phase 2 oracle/workers).
  const subagents = ctx.get('subagents')
  if (subagents === undefined) {
    ctx.logger.warn('[enpoi-runtime-probe] seam subagents ABSENT — Phase 2 oracle/worker dispatch blocked (per-seam degradation)')
    results.push('subagents: ABSENT')
  } else if (typeof subagents.startContinuable !== 'function') {
    ctx.logger.warn('[enpoi-runtime-probe] seam subagents.startContinuable MISSING — Phase 2 oracle blocked (per-seam degradation)')
    results.push('subagents.startContinuable: MISSING')
  } else {
    results.push('subagents.startContinuable: OK')
  }

  // Seam 3: llm (context keeper) + model-selection (per-persona hot-swap).
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.stream !== 'function') {
    ctx.logger.warn('[enpoi-runtime-probe] seam llm.stream ABSENT — context keeper disabled (per-seam degradation)')
    results.push('llm.stream: ABSENT')
  } else {
    results.push('llm.stream: OK')
  }

  const agents = ctx.get('agents')
  // installModelSelection is a standalone export of model-selection.ts, not a
  // service method — its removal breaks our bundle at BUILD time (esbuild
  // fails), so no runtime check is meaningful here. The agents service
  // presence is the runtime signal for per-persona hot-swap availability.
  if (agents === undefined) {
    ctx.logger.warn('[enpoi-runtime-probe] seam agents ABSENT — per-persona hot-swap unavailable (per-seam degradation; session default model used)')
    results.push('agents: ABSENT')
  } else {
    results.push('agents: OK')
  }

  ctx.logger.info(`[enpoi-runtime-probe] seams: ${results.join(' · ')}`)
  diag(`seams: ${results.join(' · ')}`)
}