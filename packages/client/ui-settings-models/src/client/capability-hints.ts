/**
 * The browser half's loader for the shared capability-hint table.
 *
 * `MODEL_CAPABILITY_HINTS` in `model-capability-hints.generated.ts` is the
 * generated mirror of the sync package's `model-capability-hints.json`; this
 * module turns it into id lookups. Everything it returns is a HINT: the
 * provider detail panel renders hinted badges differently from disclosed
 * ones, and the sync persists a hint only under the labeled
 * `capabilityHints` field, never as a fact.
 *
 * @module ui-settings-models/capability-hints
 */

import { MODEL_CAPABILITY_HINTS, type ModelCapabilityHints } from './model-capability-hints.generated.ts'

/** One modality an id hint may add on top of the text floor. */
export type HintedModality = 'image' | 'audio' | 'video' | 'pdf'

/** The hints one model id carries in the shared table. */
export interface IdCapabilityHints {
  /** Modality tokens beyond text the hints suggest. */
  input: HintedModality[]
  /** Whether the hints suggest reasoning. */
  reasoning: boolean
  /** Whether the id is on the tools-exclusion list. */
  toolsExcluded: boolean
}

/**
 * Whether one lowercased model id carries any of the operands.
 * @param lowerId - the lowercased model id.
 * @param operands - lowercase id substrings.
 * @returns true when at least one operand occurs in the id.
 */
export function matchesAnyOperand(lowerId: string, operands: readonly string[]): boolean {
  return operands.some(operand => operand.length > 0 && lowerId.includes(operand))
}

/**
 * Resolve one model id against the shared table.
 * @param id - the model id; matching is case-insensitive.
 * @param hints - the table; defaults to the generated shipped mirror.
 * @returns the hinted modalities, reasoning, and tools exclusion.
 */
export function idCapabilityHints(id: string, hints: ModelCapabilityHints = MODEL_CAPABILITY_HINTS): IdCapabilityHints {
  const lowerId = id.toLowerCase()
  const input: HintedModality[] = []
  if (matchesAnyOperand(lowerId, hints.image)) input.push('image')
  if (matchesAnyOperand(lowerId, hints.audio)) input.push('audio')
  if (matchesAnyOperand(lowerId, hints.video)) input.push('video')
  if (matchesAnyOperand(lowerId, hints.files)) input.push('pdf')
  return {
    input,
    reasoning: matchesAnyOperand(lowerId, hints.reasoning),
    toolsExcluded: matchesAnyOperand(lowerId, hints.toolsExclude),
  }
}
