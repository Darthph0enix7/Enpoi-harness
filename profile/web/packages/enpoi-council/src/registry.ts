/**
 * Council registry — settings-defined councils layered over the code defaults.
 *
 * `enpoi-orchestration.councils` is a map of councilId → declarative council
 * definition (the JSON-safe shape from `core/spec.ts`); an entry may also carry
 * `disabled: true` to retire a council (its tool disappears). The built-in
 * `roundtable` and `chorus` specs remain CODE DEFAULTS used when settings has
 * no entry for that id; a settings entry with the same id OVERRIDES the code
 * default (rewrite) or retires it.
 *
 * Validation is loud by design: every invalid entry names its council id and
 * the exact problem (schema path + message) on stderr and in the council log,
 * and is excluded from the enabled set — nothing is skipped silently.
 *
 * Model routing (doc 54 §2.2): seats are read from the spec, and the engine
 * resolves `enpoi-orchestration.personas[<seatId>]` generically
 * (`core/fiber.ts:resolvePersonaModel`), so seats contributed by registered
 * councils route exactly like the built-ins. `referee` and `chair` are
 * reserved arbiter ids and never seat ids.
 */
import type { Context } from '@deepseek-ai/cordis'
import { readOrchestrationDocument, type SettingsDocumentReader } from 'dsh-enpoi-contracts'
import { councilDiag } from './core/fiber.ts'
import {
  validateSpec,
  type CouncilSpec,
  type DeclarativeCouncilSpec,
  type SeatSpec,
} from './core/spec.ts'
import { CHORUS_SPEC } from './profiles/chorus.ts'
import { ROUNDTABLE_SPEC } from './profiles/roundtable.ts'

/** Settings namespace every enpoi plugin shares (owned by enpoi-capabilities). */
export const ORCH_NAMESPACE = 'enpoi-orchestration'

/** Fixed arbiter roles every council runs with (never seats). */
export const ARBITER_IDS = ['referee', 'chair'] as const

/** Tool names the council plugin owns and a council id may never claim. */
export const COUNCIL_MANAGEMENT_TOOL_IDS: readonly string[] = ['council_register', 'council_list']

/** Council ids that have a code-default spec in this plugin. */
export const BUILTIN_COUNCIL_IDS: readonly string[] = [ROUNDTABLE_SPEC.id, CHORUS_SPEC.id]

/** One settings entry: a declarative council plus the retire switch. */
export type CouncilSettingsEntry = Partial<DeclarativeCouncilSpec> & { disabled?: boolean }

/** Seat projection for the tool/RPC surfaces (family omitted when neutral). */
export interface CouncilSeatView {
  id: string
  label: string
  family?: SeatSpec['family']
}

/** One resolved council: the effective spec plus the facts both host surfaces read. */
export interface CouncilEntry {
  id: string
  label: string
  description: string
  seats: CouncilSeatView[]
  /** True when the id has a code-default council in this plugin. */
  builtin: boolean
  /** False when retired (`disabled: true`) or excluded after a validation failure. */
  enabled: boolean
  /** Effective engine spec; `null` only when the entry failed validation. */
  spec: CouncilSpec | null
  /** The settings declaration (stopping policy + chair template); `null` for code defaults. */
  declarative: DeclarativeCouncilSpec | null
  /** Validation problem for an invalid entry — never set on a valid one. */
  error?: string
}

/** Resolved registry: every known council plus every validation problem. */
export interface CouncilRegistry {
  entries: CouncilEntry[]
  errors: Array<{ id: string; problem: string }>
}

/**
 * Report one council configuration problem loudly: stderr for the service log
 * and the council diagnostics file. Never throws.
 * @param id - the council id (or `(settings)` for document-level problems).
 * @param problem - the exact problem (validation path + message).
 */
export function councilProblem(id: string, problem: string): void {
  const line = `[enpoi-council] invalid council "${id}": ${problem}`
  try {
    process.stderr.write(`${line}\n`)
  } catch {
    // stderr is best-effort; the log file below remains
  }
  councilDiag(line)
}

/**
 * Convert a declarative council definition into the engine spec. Defaults the
 * optional fields exactly as `CouncilSpecSchema` would; structural validation
 * stays with {@link validateSpec}.
 * @param decl - the declarative definition (its `id` wins).
 * @returns the engine spec candidate.
 */
export function councilSpecFromDeclarative(decl: DeclarativeCouncilSpec): CouncilSpec {
  return {
    id: decl.id,
    label: decl.label,
    description: decl.description ?? '',
    seats: decl.seats.map(seat => ({
      id: seat.id,
      label: seat.label,
      persona: seat.persona,
      opGates: seat.opGates ?? [],
      family: seat.family ?? 'neutral',
    })),
    ledgerKinds: decl.ledgerKinds,
    actions: decl.actions,
    steelman: decl.steelman ?? false,
    scopeContract: decl.scopeContract ?? '',
    opening: decl.opening ?? 'blind',
    preflightInventory: false,
    forestMode: decl.forestMode ?? false,
    deliverableSections: decl.deliverableSections,
  }
}

/**
 * Turn a validated declarative definition into a settings entry (id included)
 * suitable for `settings.mutate` under `councils[id]`.
 * @param decl - the complete declarative definition.
 * @returns a detached plain-object entry.
 */
export function councilSettingsEntry(decl: DeclarativeCouncilSpec): Record<string, unknown> {
  return JSON.parse(JSON.stringify(decl)) as Record<string, unknown>
}

/**
 * Read the raw `enpoi-orchestration.councils` map. A malformed map or an
 * unreadable namespace resolves as absent and reports the problem through
 * {@link loadCouncilRegistry} so one bad document cannot brick the plugin.
 * @param ctx - owning plugin context.
 * @returns the raw council map (possibly empty) plus any document-level problem.
 */
export function readCouncilSettings(ctx: Context): { councils: Record<string, unknown>; problem?: string } {
  try {
    const doc = readOrchestrationDocument(ctx.get('settings') as SettingsDocumentReader | undefined)
    const councils = doc?.councils
    if (councils === undefined) return { councils: {} }
    if (!isPlainObject(councils)) {
      return { councils: {}, problem: `"${ORCH_NAMESPACE}.councils" must be a map of councilId → declarative spec` }
    }
    return { councils }
  } catch (err) {
    return { councils: {}, problem: `cannot read "${ORCH_NAMESPACE}.councils": ${String(err)}` }
  }
}

/**
 * Invalid council problems already reported — the UI list is read repeatedly,
 * so an unchanged problem must not spam stderr/the log on every read.
 */
const reportedProblems = new Set<string>()

/**
 * Resolve the full council registry fresh from settings (hot-swap: callers
 * rebuild on `settings/updated`, never cache).
 * @param ctx - owning plugin context.
 * @returns every known council in stable order (built-ins first, then settings-only ids).
 */
export function loadCouncilRegistry(ctx: Context): CouncilRegistry {
  const { councils: raw, problem } = readCouncilSettings(ctx)
  const entries: CouncilEntry[] = []
  const errors: CouncilRegistry['errors'] = []
  if (problem !== undefined) errors.push({ id: '(settings)', problem })

  for (const builtin of [ROUNDTABLE_SPEC, CHORUS_SPEC]) {
    const entry = raw[builtin.id] === undefined
      ? codeDefaultEntry(builtin)
      : settingsEntry(builtin.id, raw[builtin.id], builtin)
    entries.push(entry)
    if (entry.error !== undefined) errors.push({ id: entry.id, problem: entry.error })
  }

  for (const [id, value] of Object.entries(raw)) {
    if (BUILTIN_COUNCIL_IDS.includes(id)) continue
    const entry = settingsEntry(id, value, null)
    entries.push(entry)
    if (entry.error !== undefined) errors.push({ id: entry.id, problem: entry.error })
  }

  const seen = new Set<string>()
  for (const problem of errors) {
    const key = `${problem.id}\u0000${problem.problem}`
    seen.add(key)
    if (!reportedProblems.has(key)) councilProblem(problem.id, problem.problem)
  }
  reportedProblems.clear()
  for (const key of seen) reportedProblems.add(key)
  return { entries, errors }
}

/**
 * Validate one declarative definition end to end: convertible to an engine
 * spec, structurally valid, and carrying well-formed declarative extras.
 * @param raw - the candidate declarative definition (tool/settings boundary).
 * @returns the admitted definition, or the exact problems.
 */
export function validateDeclarativeCouncil(raw: unknown): { spec?: CouncilSpec; decl?: DeclarativeCouncilSpec; errors: string[] } {
  if (!isPlainObject(raw)) return { errors: ['council definition must be a JSON object'] }
  const decl = raw as unknown as DeclarativeCouncilSpec
  if (typeof decl.id !== 'string' || typeof decl.label !== 'string' || !Array.isArray(decl.seats)) {
    return { errors: ['council definition needs "id", "label", and a "seats" array'] }
  }
  let candidate: CouncilSpec
  try {
    candidate = councilSpecFromDeclarative(decl)
  } catch (err) {
    return { errors: [`cannot read the council definition: ${String(err)}`] }
  }
  const { spec, validation } = validateSpec(candidate)
  const errors = [...validation.errors]
  const policy = (decl as { stoppingPolicy?: unknown }).stoppingPolicy
  if (policy === undefined || !isPlainObject(policy)) {
    errors.push('stoppingPolicy: required ({ type, stagnationLimit?, maxEpochs? })')
  } else {
    const type = policy.type
    if (type !== 'ledger_convergence' && type !== 'topological_saturation' && type !== 'fixed_epochs') {
      errors.push(`stoppingPolicy.type: must be ledger_convergence, topological_saturation, or fixed_epochs (got ${JSON.stringify(type)})`)
    }
    const stagnation = policy.stagnationLimit
    if (stagnation !== undefined && (!Number.isInteger(stagnation) || stagnation < 1 || stagnation > 6)) {
      errors.push('stoppingPolicy.stagnationLimit: must be an integer 1..6')
    }
    const maxEpochs = policy.maxEpochs
    if (maxEpochs !== undefined && (!Number.isInteger(maxEpochs) || maxEpochs < 1 || maxEpochs > 12)) {
      errors.push('stoppingPolicy.maxEpochs: must be an integer 1..12')
    }
  }
  const chair = (decl as { chairTemplate?: unknown }).chairTemplate
  if (chair === undefined || !isPlainObject(chair)) {
    errors.push('chairTemplate: required ({ systemPrompt, userPromptTemplate })')
  } else {
    if (typeof chair.systemPrompt !== 'string' || chair.systemPrompt.trim() === '') errors.push('chairTemplate.systemPrompt: must be a non-empty string')
    if (typeof chair.userPromptTemplate !== 'string' || chair.userPromptTemplate.trim() === '') errors.push('chairTemplate.userPromptTemplate: must be a non-empty string')
  }
  return errors.length === 0 && spec !== undefined ? { spec, decl, errors } : { errors }
}

// ---------------------------------------------------------------------------
// UI projection (shared by the management tool and the enpoiCouncil Remote)
// ---------------------------------------------------------------------------

/** One council row for the UI. */
export interface CouncilView {
  id: string
  label: string
  seats: CouncilSeatView[]
  arbiters: ['referee', 'chair']
  enabled: boolean
  /** Validation problem for a configured council that was rejected at load. */
  error?: string
}

/** The complete council list payload. */
export interface CouncilListView {
  councils: CouncilView[]
}

/**
 * Read the current council list for the UI. Same resolution as the tool
 * registry, so what the client renders is exactly what can run.
 * @param ctx - owning plugin context.
 * @returns every known council in stable order (built-ins first, then settings-only ids).
 */
export function councilListView(ctx: Context): CouncilListView {
  const registry = loadCouncilRegistry(ctx)
  return {
    councils: registry.entries.map(entry => ({
      id: entry.id,
      label: entry.label,
      seats: entry.seats,
      arbiters: ['referee', 'chair'],
      enabled: entry.enabled,
      // A configured-but-rejected council stays visible with its validation
      // problem so the operator can fix the spec instead of guessing.
      ...entry.error === undefined ? {} : { error: entry.error },
    })),
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function codeDefaultEntry(spec: CouncilSpec): CouncilEntry {
  return {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    seats: seatViews(spec),
    builtin: true,
    enabled: true,
    spec,
    declarative: null,
  }
}

function settingsEntry(id: string, raw: unknown, builtin: CouncilSpec | null): CouncilEntry {
  if (!isPlainObject(raw)) {
    const problem = 'entry must be an object of declarative council fields'
    return invalidEntry(id, builtin, problem)
  }
  const disabled = raw.disabled === true
  const declared = Object.keys(raw).filter(key => key !== 'disabled')
  if (declared.length === 0) {
    // A bare `{ disabled: true }` retires a built-in; without one there is
    // nothing to hide, which is a misconfiguration worth naming.
    if (builtin !== null) return { ...codeDefaultEntry(builtin), enabled: !disabled }
    return invalidEntry(id, null, 'disabled entry has no declarative spec and no built-in council with this id')
  }
  const declaredId = raw.id
  if (declaredId !== undefined && declaredId !== id) {
    return invalidEntry(id, builtin, `declared id ${JSON.stringify(declaredId)} does not match settings key "${id}"`)
  }
  const { spec, decl, errors } = validateDeclarativeCouncil({ ...raw, id })
  if (spec === undefined || decl === undefined) return invalidEntry(id, builtin, errors.join('; '))
  return {
    id,
    label: spec.label,
    description: spec.description,
    seats: seatViews(spec),
    builtin: builtin !== null,
    enabled: !disabled,
    spec,
    declarative: decl,
  }
}

function invalidEntry(id: string, builtin: CouncilSpec | null, problem: string): CouncilEntry {
  const base = builtin === null ? null : codeDefaultEntry(builtin)
  return {
    id,
    label: base?.label ?? id,
    description: base?.description ?? '',
    seats: base?.seats ?? [],
    builtin: builtin !== null,
    enabled: false,
    spec: null,
    declarative: null,
    error: problem,
  }
}

function seatViews(spec: CouncilSpec): CouncilSeatView[] {
  return spec.seats.map(seat => ({
    id: seat.id,
    label: seat.label,
    ...(seat.family === 'neutral' ? {} : { family: seat.family }),
  }))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
