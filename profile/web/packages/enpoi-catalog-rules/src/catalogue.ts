/**
 * enpoi-catalog-rules — read the live synced catalogue.
 *
 * The catalogue is the same `llm-pi-ai.providers` document the provider-sync
 * plugin writes and the picker reads. This module projects each route's
 * `models` array into {@link CatalogEntry}; malformed rows are skipped rather
 * than failing the whole read. Rules never mutate this document.
 */

import { readSettingsDocument, type SettingsDocumentReader } from 'dsh-enpoi-contracts'
import { isRecord, type CatalogEntry, type CatalogCost } from './rules.ts'

/** Longest accepted provider/model id. */
const MAX_ID_CHARS = 512

/** A trimmed non-empty string within the id length cap, or undefined. */
function idString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' || trimmed.length > MAX_ID_CHARS ? undefined : trimmed
}

/** A finite non-negative number, or undefined. */
function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Parse one model entry, or undefined when it has no usable id. */
function parseModel(provider: string, raw: unknown): CatalogEntry | undefined {
  if (!isRecord(raw)) return undefined
  const id = idString(raw.id)
  if (id === undefined) return undefined
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : undefined
  const contextWindow = optionalNumber(raw.contextWindow)
  const maxTokens = optionalNumber(raw.maxTokens)
  const input = Array.isArray(raw.input) ? raw.input.filter((item): item is string => typeof item === 'string') : undefined
  const reasoning = typeof raw.reasoning === 'boolean' ? raw.reasoning : undefined
  const tools = typeof raw.tools === 'boolean' ? raw.tools : undefined
  const cost: CatalogCost | undefined = isRecord(raw.cost)
    ? {
        ...(optionalNumber(raw.cost.input) !== undefined ? { input: optionalNumber(raw.cost.input)! } : {}),
        ...(optionalNumber(raw.cost.output) !== undefined ? { output: optionalNumber(raw.cost.output)! } : {}),
      }
    : undefined
  // The provider sync stamps `gated`/`gateReason` on a model its listing marked
  // sign-in/paid-only (`isFree: false`). The gate flag feeds the rules engine's
  // `gated` predicate and decision; the reason is the picker's dim string.
  const gateReason = raw.gated === true && typeof raw.gateReason === 'string' && raw.gateReason.trim() !== ''
    ? raw.gateReason.trim()
    : undefined
  return {
    provider,
    id,
    ...(name !== undefined ? { name } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(cost !== undefined && Object.keys(cost).length > 0 ? { cost } : {}),
    ...(raw.gated === true ? { gated: true } : {}),
    ...(gateReason === undefined ? {} : { gateReason }),
  }
}

/**
 * Project the live `llm-pi-ai` provider document into catalogue entries.
 * @param settings - the `settings` service from `ctx.get('settings')`.
 * @returns every usable entry, provider-major, each provider/id once.
 */
export function readCatalogue(settings: SettingsDocumentReader | undefined): CatalogEntry[] {
  const document = readSettingsDocument(settings, 'llm-pi-ai')
  if (document === undefined) return []
  const providers = document.providers
  if (!isRecord(providers)) return []
  const entries: CatalogEntry[] = []
  const seen = new Set<string>()
  for (const [provider, profile] of Object.entries(providers)) {
    if (!isRecord(profile) || !Array.isArray(profile.models)) continue
    for (const raw of profile.models) {
      const entry = parseModel(provider, raw)
      if (entry === undefined) continue
      const key = `${entry.provider}/${entry.id}`
      if (seen.has(key)) continue
      seen.add(key)
      entries.push(entry)
    }
  }
  return entries
}
