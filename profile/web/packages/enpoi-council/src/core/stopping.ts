/**
 * Stopping — pure predicates over ledger state (doc 54 §5, §13 amendment 6).
 *
 * NO LLM input. The engine diffs entry statuses; these predicates decide:
 *   convergence  → all entries terminal (open cruxes = 0)
 *   stagnation   → zero status flips for `stagnationLimit` consecutive epochs
 *                  → fire the FINAL CHALLENGE epoch (exactly once)
 *   bounds       → maxRounds / token ceiling (safety nets, never targets)
 *
 * Final challenge semantics (precise, Oracle-gated):
 *   - challenge fires at most once per run;
 *   - zero flips in the challenge → terminate immediately;
 *   - any flip in the challenge → exactly ONE consolidation epoch → terminate
 *     unconditionally; the stagnation counter never resets after the challenge.
 */
import type { CouncilParams, LedgerState, StopVerdict } from './spec.ts'

export interface StoppingRuntime {
  /** Epochs with zero flips, contiguous, ending at the current epoch. */
  zeroFlipRun: number
  /** Whether the final-challenge epoch already ran. */
  challengeFired: boolean
  /** Whether the post-challenge consolidation epoch already ran. */
  consolidationFired: boolean
  /** Estimated cumulative tokens (engine-maintained). */
  tokens: number
}

export function initialRuntime(): StoppingRuntime {
  return { zeroFlipRun: 0, challengeFired: false, consolidationFired: false, tokens: 0 }
}

/** Call after each epoch's ledger diff. Returns the next action for the engine loop. */
export function evaluate(
  state: LedgerState,
  runtime: StoppingRuntime,
  params: CouncilParams,
  terminalStatuses: ReadonlySet<string>,
): StopVerdict {
  // Hard bounds first.
  if (state.epoch >= params.defaultMaxRounds) {
    return { action: 'terminate', reason: `max rounds (${params.defaultMaxRounds}) reached` }
  }
  if (runtime.tokens >= params.maxDebateTokens) {
    return { action: 'terminate', reason: `token ceiling (${params.maxDebateTokens}) reached` }
  }

  // Convergence: every entry is in a terminal status.
  const open = state.entries.filter(e => !terminalStatuses.has(e.status)).length
  if (state.entries.length > 0 && open === 0) {
    return { action: 'terminate', reason: 'all ledger entries reached terminal states' }
  }

  // Empty ledger: nothing was ever admitted — a final challenge over nothing
  // is pointless, so terminate as soon as the loop sees it.
  if (state.entries.length === 0) {
    return { action: 'terminate', reason: 'no ledger entries were ever admitted' }
  }

  // Stagnation → final challenge (once).
  if (runtime.zeroFlipRun >= params.stagnationLimit) {
    if (params.challengeRound && !runtime.challengeFired) {
      return { action: 'final-challenge', reason: `no ledger movement for ${runtime.zeroFlipRun} epochs` }
    }
    return { action: 'terminate', reason: `stagnation (${runtime.zeroFlipRun} epochs without a state flip)` }
  }

  return { action: 'continue' }
}

/** Engine calls after the final-challenge epoch decides the post-challenge path. */
export function afterChallenge(flipsInChallenge: number, runtime: StoppingRuntime): StopVerdict {
  runtime.challengeFired = true
  if (flipsInChallenge === 0) {
    return { action: 'terminate', reason: 'final challenge produced no state changes' }
  }
  if (runtime.consolidationFired) {
    return { action: 'terminate', reason: 'consolidation epoch after the final challenge complete' }
  }
  runtime.consolidationFired = true
  return { action: 'continue', ...{} } as StopVerdict
}

/**
 * Runtime zeroFlipRun maintenance. A challenge epoch never resets the run
 * (doc 54 §13): flips there only route into the single consolidation epoch.
 */
export function trackFlipRun(runtime: StoppingRuntime, flipsThisEpoch: number, isChallengeEpoch: boolean): void {
  if (isChallengeEpoch) return
  if (flipsThisEpoch > 0) runtime.zeroFlipRun = 0
  else runtime.zeroFlipRun += 1
}
