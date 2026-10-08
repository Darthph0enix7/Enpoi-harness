/**
 * The default-route facts the first-run wizard states.
 *
 * The wizard names the route a fresh installation talks to. Nothing about that
 * route is static product copy: the live Models join already carries its
 * display name, protocol, base URL, credential model, and free verdict, and
 * the shipped preset is the fallback when the join has no row yet (before the
 * first settings answer). This module derives that fact set in one place.
 *
 * @module ui-settings-models/default-route
 */

import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { providerPreset } from './provider-templates.ts'
import type { ProviderRow } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import { WIZARD_FREE_MODEL, WIZARD_FREE_PROVIDER } from './welcome-wizard.ts'

/** The default route as the wizard renders it. */
export interface DefaultRouteFacts {
  /** Route id (for example `kilo`). */
  id: string
  /** Display name, from the live profile or the shipped preset. */
  name: string
  /** Wire protocol identifier; empty when neither source names one. */
  protocol: string
  /** Endpoint base URL; empty when neither source names one. */
  baseURL: string
  /** Whether the route serves without a credential. */
  free: boolean
  /** First configured model id, for the helper-seat route line. */
  model: string
}

/** Read one non-empty string field from a profile record. */
function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** First model id a profile's `models` array names, when any. */
function firstModelId(models: unknown): string | undefined {
  if (!Array.isArray(models)) return undefined
  for (const entry of models) {
    if (typeof entry !== 'object' || entry === null) continue
    const id = stringField(entry as Record<string, unknown>, 'id')
    if (id !== undefined) return id
  }
  return undefined
}

/**
 * Derive the default-route facts from the same join the Models page renders:
 * the live row for the shipped default provider, its resolved settings
 * profile, and the generated preset as the pre-connection fallback. A profile
 * field wins over the preset; the preset wins over the bare id.
 * @param input - the shared Models join rows, namespace views, and schema face.
 * @returns the facts; every field is a string or boolean and never undefined.
 */
export function deriveDefaultRoute(input: {
  rows: readonly ProviderRow[]
  namespaces: ReadonlyMap<string, SettingsNamespaceView>
  schema: SettingsSchemaOperations
}): DefaultRouteFacts {
  const preset = providerPreset(WIZARD_FREE_PROVIDER)
  /* v8 ignore next 3 -- the generated catalog always carries the shipped default route */
  if (preset === undefined) {
    throw new Error(`the generated provider catalog no longer carries "${WIZARD_FREE_PROVIDER}"`)
  }
  const row = input.rows.find(candidate => candidate.entry.provider === WIZARD_FREE_PROVIDER)
  const namespace = row === undefined ? undefined : input.namespaces.get(row.entry.settingsNs)
  const raw = row === undefined || namespace === undefined
    ? undefined
    : input.schema.getPath(namespace.value, row.entry.settingsPath)
  const profile = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  return {
    id: WIZARD_FREE_PROVIDER,
    name: stringField(profile, 'displayName') ?? row?.entry.displayName ?? preset.name,
    protocol: stringField(profile, 'api') ?? preset.protocol,
    baseURL: stringField(profile, 'baseURL') ?? preset.baseURL,
    free: typeof profile['keyless'] === 'boolean' ? profile['keyless'] : preset.keyless === true,
    model: firstModelId(profile['models']) ?? WIZARD_FREE_MODEL,
  }
}
