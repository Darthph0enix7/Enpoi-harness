/**
 * Live `enpoi-orchestration.parameters.compaction` prune budgets.
 *
 * The pruner reads the shared Enpoi orchestration document directly so an
 * operator edit applies on the next prune without a restart. The read is
 * best-effort and fails open: a missing service, entry, or malformed field
 * yields no override and the resolved plugin config applies.
 *
 * @module @deepseek-ai/dsh-compaction-tool-result-pruner/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolResultPruneConfig } from './types.ts'

/** Namespace owning the shared Enpoi orchestration document. */
const ORCHESTRATION_NS = 'enpoi-orchestration'

/** Structural view of the Settings service read through `ctx.get('settings')`. */
interface SettingsHandle {
  describe?: () => ReadonlyArray<{ ns: string; value?: unknown }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * Read the `parameters.compaction` prune budgets. Each field is validated
 * independently; an invalid field is omitted so the plugin default applies.
 * @param ctx - context that may provide the Settings service.
 * @returns validated prune overrides; empty when nothing usable is configured.
 */
export function readPruneSettings(ctx: Context): ToolResultPruneConfig {
  try {
    const settings = ctx.get('settings') as SettingsHandle | undefined
    const value = settings?.describe?.().find(entry => entry.ns === ORCHESTRATION_NS)?.value
    if (!isRecord(value)) return {}
    const parameters = value.parameters
    const raw = isRecord(parameters) ? parameters.compaction : undefined
    if (!isRecord(raw)) return {}
    const config: ToolResultPruneConfig = {}
    const thresholdChars = positiveInteger(raw.pruneThresholdChars)
    if (thresholdChars !== undefined) config.thresholdChars = thresholdChars
    const headChars = nonNegativeInteger(raw.pruneHeadChars)
    if (headChars !== undefined) config.headChars = headChars
    const tailChars = nonNegativeInteger(raw.pruneTailChars)
    if (tailChars !== undefined) config.tailChars = tailChars
    return config
  } catch {
    // A settings read is best-effort: a provider fault must not fail pruning.
    return {}
  }
}
