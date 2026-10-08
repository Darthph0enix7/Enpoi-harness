/**
 * Operator overlay for the pre-connection heavy-provider fallback.
 *
 * The host's private `$DSH_HOME/heavy-server-overlay.json` is the single
 * operator-owned control plane for heavy manifests. The profile plugin
 * (`enpoi-heavy-providers`) applies it to the host manifest table, and the
 * Host half of this package publishes the same document as the page global
 * {@link HEAVY_OVERLAY_GLOBAL} at index render, so this module can apply it to
 * the compiled fallback before the first `enpoiHeavy.manifests` reply — the
 * fallback is no longer immutable pre-connection. Once a host reply arrives,
 * the host table (already overlay-applied) replaces the fallback wholesale and
 * this overlay stops applying.
 *
 * Every field is sanitized before use: the overlay is operator-owned JSON, and
 * an absent, malformed, or partially invalid document must degrade to "no
 * override" rather than reach render code. A `null` on an optional field
 * removes the shipped value; `disabled: true` removes the provider.
 *
 * @module ui-settings-models/heavy-overlay
 */

import type {
  HeavyManifestPool,
  HeavyManifestPoolIdentity,
  HeavyProviderManifest,
  HeavyProviderStep,
} from './client/heavy-providers.ts'

/** Page-global key carrying the sanitized operator overlay document. */
export const HEAVY_OVERLAY_GLOBAL = '__DSH_HEAVY_OVERLAY__'

/** One provider's operator overrides; every field is optional. */
export interface HeavyOverlayEntry {
  /** Remove the provider from the rendered table (the host refuses its operations too). */
  disabled?: boolean
  label?: string
  summary?: string
  /** Replacement dashboard link; `null` removes the shipped one. */
  dashboardUrl?: string | null
  /** Replacement docs link; `null` removes the shipped one. */
  docsUrl?: string | null
  reuseBaseURL?: string
  reuseHealthURL?: string
  /** Replacement local install steps, applied to every supported platform variant. */
  installSteps?: readonly HeavyProviderStep[]
  /** Replacement fallback model; `null` removes the shipped one. */
  fallbackModel?: string | null
  /** Replacement credential pool; `null` removes the shipped one. */
  pool?: HeavyManifestPool | null
}

/** The sanitized overlay document: provider id → overrides. */
export interface HeavyOverlayDocument {
  providers: Readonly<Record<string, HeavyOverlayEntry>>
}

/** Whether a wire value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A non-empty string field, or undefined when absent/blank/mistyped. */
function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** An optional string field: `null` (or an empty string) removes, a string sets. */
function nullableStringField(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key]
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  return value === '' ? null : value
}

/** A positive progress weight, or undefined. */
function weightField(record: Record<string, unknown>): number | undefined {
  const value = record.weight
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Sanitize an install-step list: every step needs a non-empty label and
 * command. A malformed list is ignored whole (no partial override).
 */
function stepsField(value: unknown): readonly HeavyProviderStep[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const steps: HeavyProviderStep[] = []
  for (const raw of value) {
    if (!isRecord(raw)) return undefined
    const label = stringField(raw, 'label')
    const command = stringField(raw, 'command')
    if (label === undefined || command === undefined) return undefined
    const cwd = stringField(raw, 'cwd')
    const weight = weightField(raw)
    steps.push({
      label,
      command,
      ...cwd === undefined ? {} : { cwd },
      ...raw.optional === true ? { optional: true } : {},
      ...weight === undefined ? {} : { weight },
    })
  }
  return steps
}

/** Sanitize one pool identity. */
function identityField(raw: unknown): HeavyManifestPoolIdentity | undefined {
  if (!isRecord(raw)) return undefined
  const id = stringField(raw, 'id')
  const credentialRef = stringField(raw, 'credentialRef')
  if (id === undefined || credentialRef === undefined || !/^[A-Z_][A-Z0-9_]*$/.test(credentialRef)) return undefined
  const priority = raw.priority
  if (priority !== undefined && (typeof priority !== 'number' || !Number.isSafeInteger(priority) || priority < 0)) {
    return undefined
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return undefined
  return {
    id,
    credentialRef,
    ...typeof priority === 'number' ? { priority } : {},
    ...typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {},
  }
}

/** Sanitize a pool override: `null` removes, a valid pool replaces, anything else is ignored. */
function poolField(value: unknown): HeavyManifestPool | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const strategy = value.strategy
  if (strategy !== undefined && strategy !== 'priority-sticky' && strategy !== 'balanced') return undefined
  if (!Array.isArray(value.identities) || value.identities.length === 0) return undefined
  const identities: HeavyManifestPoolIdentity[] = []
  const seen = new Set<string>()
  for (const raw of value.identities) {
    const identity = identityField(raw)
    if (identity === undefined || seen.has(identity.id)) return undefined
    seen.add(identity.id)
    identities.push(identity)
  }
  return { ...strategy === undefined ? {} : { strategy }, identities }
}

/** Sanitize one overlay entry; undefined when it carries no usable override. */
function entryField(raw: unknown): HeavyOverlayEntry | undefined {
  if (!isRecord(raw)) return undefined
  const entry: HeavyOverlayEntry = {}
  if (raw.disabled === true) entry.disabled = true
  const label = stringField(raw, 'label')
  if (label !== undefined) entry.label = label
  const summary = stringField(raw, 'summary')
  if (summary !== undefined) entry.summary = summary
  const dashboardUrl = nullableStringField(raw, 'dashboardUrl')
  if (dashboardUrl !== undefined) entry.dashboardUrl = dashboardUrl
  const docsUrl = nullableStringField(raw, 'docsUrl')
  if (docsUrl !== undefined) entry.docsUrl = docsUrl
  const reuseBaseURL = stringField(raw, 'reuseBaseURL')
  if (reuseBaseURL !== undefined) entry.reuseBaseURL = reuseBaseURL
  const reuseHealthURL = stringField(raw, 'reuseHealthURL')
  if (reuseHealthURL !== undefined) entry.reuseHealthURL = reuseHealthURL
  const installSteps = stepsField(raw.installSteps)
  if (installSteps !== undefined) entry.installSteps = installSteps
  const fallbackModel = nullableStringField(raw, 'fallbackModel')
  if (fallbackModel !== undefined) entry.fallbackModel = fallbackModel
  const pool = poolField(raw.pool)
  if (pool !== undefined) entry.pool = pool
  return Object.keys(entry).length === 0 ? undefined : entry
}

/**
 * Parse an operator overlay document (the `$DSH_HOME` file or the page
 * global). Tolerant: malformed entries and fields are dropped, so an invalid
 * overlay degrades to "no override".
 * @param raw - the candidate document.
 * @returns the sanitized document; `{ providers: {} }` for anything else.
 */
export function parseHeavyOverlay(raw: unknown): HeavyOverlayDocument {
  if (!isRecord(raw) || !isRecord(raw.providers)) return { providers: {} }
  const providers: Record<string, HeavyOverlayEntry> = {}
  for (const [id, value] of Object.entries(raw.providers)) {
    const entry = entryField(value)
    if (id !== '' && entry !== undefined) providers[id] = entry
  }
  return { providers }
}

/** Read the page-bootstrap overlay the Host half injected, when it did. */
export function readHeavyOverlayGlobal(): HeavyOverlayDocument {
  const page = globalThis as Partial<Record<typeof HEAVY_OVERLAY_GLOBAL, unknown>>
  return parseHeavyOverlay(page[HEAVY_OVERLAY_GLOBAL])
}

/** Replace the steps of every supported platform variant, keeping refusals. */
function withInstallSteps(local: HeavyProviderManifest['local'], steps: readonly HeavyProviderStep[]): HeavyProviderManifest['local'] {
  const install = { ...local.install }
  for (const platform of ['default', 'linux', 'darwin', 'win32'] as const) {
    const variant = install[platform]
    if (variant === undefined || variant.unsupported !== undefined) continue
    install[platform] = { ...variant, steps }
  }
  return { ...local, install }
}

/** Apply one sanitized entry to one manifest. */
function overlayManifestFields(manifest: HeavyProviderManifest, entry: HeavyOverlayEntry): HeavyProviderManifest {
  const next: HeavyProviderManifest = {
    ...manifest,
    ...entry.label === undefined ? {} : { label: entry.label },
    ...entry.summary === undefined ? {} : { summary: entry.summary },
    reuse: {
      ...manifest.reuse,
      ...entry.reuseBaseURL === undefined ? {} : { baseURL: entry.reuseBaseURL },
      ...entry.reuseHealthURL === undefined ? {} : { health: { ...manifest.reuse.health, url: entry.reuseHealthURL } },
    },
    local: entry.installSteps === undefined ? manifest.local : withInstallSteps(manifest.local, entry.installSteps),
  }
  if (entry.dashboardUrl === null) delete next.dashboardUrl
  else if (entry.dashboardUrl !== undefined) next.dashboardUrl = entry.dashboardUrl
  if (entry.docsUrl === null) delete next.docsUrl
  else if (entry.docsUrl !== undefined) next.docsUrl = entry.docsUrl
  if (entry.fallbackModel === null) delete next.fallbackModel
  else if (entry.fallbackModel !== undefined) next.fallbackModel = entry.fallbackModel
  if (entry.pool === null) delete next.pool
  else if (entry.pool !== undefined) next.pool = entry.pool
  return next
}

/**
 * Apply an operator overlay to a manifest table: disabled entries are
 * removed, the rest keep their order with the entry's overrides merged. The
 * input table and its entries are never mutated.
 * @param manifests - the table to overlay (normally the compiled fallback).
 * @param overlay - the sanitized overlay document.
 * @returns the effective table; a copy of the input without an overlay.
 */
export function applyHeavyOverlay(
  manifests: readonly HeavyProviderManifest[],
  overlay: HeavyOverlayDocument,
): HeavyProviderManifest[] {
  const entries = overlay.providers
  const effective: HeavyProviderManifest[] = []
  for (const manifest of manifests) {
    const entry = entries[manifest.id]
    if (entry === undefined) {
      effective.push(manifest)
      continue
    }
    if (entry.disabled === true) continue
    effective.push(overlayManifestFields(manifest, entry))
  }
  return effective
}
