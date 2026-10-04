/**
 * enpoi-council — runtime parameters (doc 38 + doc 54 §9).
 *
 * Resolved FRESH per council start from `enpoi-orchestration` →
 * `parameters.council` (hot-swap: a settings change applies to the next
 * invocation — no restart). Old keys stay accepted for compatibility.
 */
import type { Context } from '@deepseek-ai/cordis'
import { readOrchestrationDocument, type SettingsDocumentReader } from 'dsh-enpoi-contracts'
import type { CouncilParams } from './core/spec.ts'

export interface CouncilRuntimeParams extends CouncilParams {
  /** Anti-pacing: models are never told the round cap (always true in spirit; kept for compat). */
  defaultHideLimit: boolean
  /** Immediate retries if a seat throws or returns empty. */
  debaterRetryCount: number
  /** Legacy consensus/scalar knobs (unused by the ledger engine; accepted so old settings load). */
  consensusThreshold: number
  plateauDeltaThreshold: number
}

export const COUNCIL_PARAM_DEFAULTS: CouncilRuntimeParams = {
  maxDebateTokens: 200_000,
  defaultMaxRounds: 6,
  defaultHideLimit: true,
  quorumFraction: 2 / 3,
  debaterTimeoutMs: 300_000,
  debaterRetryCount: 1,
  consensusThreshold: 0.8,
  plateauDeltaThreshold: 0.05,
  stagnationLimit: 2,
  challengeRound: true,
  evidenceBroker: true,
  evidenceTimeoutMs: 120_000,
  blindEpoch: true,
  preflightInventory: false,
  runDeadlineMs: 1_800_000,
}

/** Read the council parameters fresh from settings (hot-swap, never cached). */
export function getCouncilParams(ctx: Context): CouncilRuntimeParams {
  const d = COUNCIL_PARAM_DEFAULTS
  try {
    const doc = readOrchestrationDocument(ctx.get('settings') as SettingsDocumentReader | undefined)
    const p = (doc?.parameters as { council?: Record<string, unknown> } | undefined)?.council
    if (p === undefined || typeof p !== 'object') return d
    return {
      maxDebateTokens: num(p.maxDebateTokens, d.maxDebateTokens, 20_000, 500_000),
      defaultMaxRounds: num(p.defaultMaxRounds, d.defaultMaxRounds, 1, 12),
      defaultHideLimit: bool(p.defaultHideLimit, d.defaultHideLimit),
      quorumFraction: num(p.quorumFraction, d.quorumFraction, 0.5, 1.0),
      debaterTimeoutMs: num(p.debaterTimeoutMs, d.debaterTimeoutMs, 10_000, 600_000),
      debaterRetryCount: num(p.debaterRetryCount, d.debaterRetryCount, 0, 3),
      consensusThreshold: num(p.consensusThreshold, d.consensusThreshold, 0.5, 1.0),
      plateauDeltaThreshold: num(p.plateauDeltaThreshold, d.plateauDeltaThreshold, 0.01, 0.2),
      stagnationLimit: num(p.stagnationLimit, d.stagnationLimit, 1, 6),
      challengeRound: bool(p.challengeRound, d.challengeRound),
      evidenceBroker: bool(p.evidenceBroker, d.evidenceBroker),
      evidenceTimeoutMs: num(p.evidenceTimeoutMs, d.evidenceTimeoutMs, 15_000, 600_000),
      blindEpoch: bool(p.blindEpoch, d.blindEpoch),
      preflightInventory: bool(p.preflightInventory, d.preflightInventory),
      runDeadlineMs: num(p.runDeadlineMs, d.runDeadlineMs, 300_000, 7_200_000),
    }
  } catch {
    return d
  }
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}
