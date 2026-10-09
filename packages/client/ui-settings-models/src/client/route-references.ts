/**
 * Route-removal reference cleanup.
 *
 * Deleting a provider profile leaves every operator reference to that route
 * dangling: the main-session default model, fleet/subagent seat assignments,
 * keeper and summariser overrides, model-group links, subagent allowed routes,
 * favorites, hidden pins, and provider ordering. This module owns the one pass
 * that rewrites each of them back to its default after a successful delete:
 *
 * - `agent-default-model` provider/model reset to the built-in keyless Kilo
 *   route, or to blanks when the deployment runs `baseline: off`; a `chain`
 *   whose group the same pass drops is cleared.
 * - `enpoi-orchestration.personas.<seat>`: cleared to `null` (the seat's
 *   inherit / built-in-default state) when it names the route or a dropped
 *   group.
 * - `enpoi-orchestration.chains.<id>.links`: links naming the route are
 *   dropped; a group whose last link goes and that has no selectors is deleted.
 * - `enpoi-orchestration.uiPreferences`: favorites, hidden pins, and the
 *   provider ordering entry for the route are pruned.
 * - `subagent-model-selection.allowedModels`: entries naming the route are
 *   pruned; `enabled` resets to the shipped `false` when the list empties,
 *   because the host refuses an enabled selection with no routes.
 *
 * Probe records (`uiPreferences.providerCatalog`, `webSearchPlans`), catalogue
 * rules and their derived `catalogRules.resolved` map, group selectors, recents,
 * and per-session logged selections do not name a route as a selection and are
 * left untouched. `localStorage` mirrors the picker reads synchronously are
 * pruned alongside the server document; the group mirror self-refreshes on its
 * window event (and on the next import of ui-model-selection).
 *
 * @module ui-settings-models/route-references
 */
import type { SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { GroupWriteFailure } from './model-groups.ts'
import { MAX_GROUP_WRITE_RETRIES, ORCHESTRATION_NS } from './model-groups.ts'
import { forgetHiddenProvider } from './hidden-models.ts'
import type { ModelsWire } from './store.ts'
import { WIZARD_FREE_MODEL, WIZARD_FREE_PROVIDER } from './welcome-wizard.ts'
import { withWriteTimeout } from './write-timeout.ts'
import type { en } from './locales.ts'

/** Settings namespace owning the default (main-session) model selection. */
export const AGENT_DEFAULT_MODEL_NS = 'agent-default-model'

/** Settings namespace owning the subagent delegation route list. */
export const SUBAGENT_MODEL_SELECTION_NS = 'subagent-model-selection'

/**
 * `localStorage` mirror keys and window events the picker modules read. A
 * feature plugin cannot runtime-import another feature plugin's values, so the
 * keys are restated here exactly as ui-model-selection declares them.
 */
const FAVORITES_KEY = 'dsh_model_favorites_v2'
const PROVIDER_ORDER_KEY = 'dsh_provider_order_v2'
const PREFS_CHANGED_EVENT = 'dsh:model-picker-prefs-changed'
const GROUPS_CHANGED_EVENT = 'dsh:model-groups-changed'

/** Whether `value` is a plain JSON object (not an array or null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The record a JSON value carries, or an empty record for anything else. */
function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

/** The array a JSON value carries, or an empty array for anything else. */
function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/** A non-empty string field, or undefined. */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** What one namespace plan rewrote, for diagnostics and tests. */
export interface RouteReferencePlan {
  /** Path operations that reset the namespace; empty when nothing refers to the route. */
  readonly ops: readonly SettingsPathOpView[]
  /** Human labels of the rewritten references (diagnostics/tests). */
  readonly rewritten: readonly string[]
  /** Group ids the plan drops entirely (when links empty and no selectors). */
  readonly droppedChains: ReadonlySet<string>
}

/**
 * Plan the `enpoi-orchestration` rewrite: seat assignments, group links, and
 * the operator preferences that name the route. The document is the described
 * namespace value; malformed entries are preserved untouched.
 * @param document - the described `enpoi-orchestration` value.
 * @param removedProvider - the deleted provider route id.
 * @returns the operations, their labels, and the dropped group ids.
 */
export function buildOrchestrationPlan(document: unknown, removedProvider: string): RouteReferencePlan {
  const doc = recordOf(document)
  const ops: SettingsPathOpView[] = []
  const rewritten: string[] = []
  const droppedChains = new Set<string>()

  // Groups first: their fate feeds the seat pass below (a seat whose group the
  // pass deletes resets to its own default like a seat naming the route).
  for (const [id, raw] of Object.entries(recordOf(doc['chains']))) {
    if (!isRecord(raw)) continue
    const links = arrayOf(raw['links'])
    const kept = links.filter(link => !(isRecord(link) && link.provider === removedProvider))
    if (kept.length === links.length) continue
    if (kept.length === 0 && arrayOf(raw['selectors']).length === 0) {
      ops.push({ op: 'unset', path: ['chains', id] })
      droppedChains.add(id)
      rewritten.push(`chains.${id}: dropped (last link removed)`)
      continue
    }
    ops.push({ op: 'set', path: ['chains', id], value: { ...raw, links: kept } as JsonValue })
    rewritten.push(`chains.${id}: dropped ${links.length - kept.length} link(s)`)
  }

  for (const [seat, raw] of Object.entries(recordOf(doc['personas']))) {
    if (!isRecord(raw)) continue
    const chain = stringOf(raw['chain'])
    const namesRoute = raw['provider'] === removedProvider
    const namesDroppedGroup = chain !== undefined && droppedChains.has(chain)
    if (!namesRoute && !namesDroppedGroup) continue
    // An explicit `null` is the registry's own inherit state: it keeps a
    // persona-only seat's row while the resolver falls back to the default.
    ops.push({ op: 'set', path: ['personas', seat], value: null })
    rewritten.push(`personas.${seat}: reset to inherit`)
  }

  const prefs = recordOf(doc['uiPreferences'])
  const favorites = arrayOf(prefs['favorites'])
  const keptFavorites = favorites.filter(entry => !(isRecord(entry) && entry.provider === removedProvider))
  if (keptFavorites.length !== favorites.length) {
    ops.push({ op: 'set', path: ['uiPreferences', 'favorites'], value: keptFavorites as JsonValue })
    rewritten.push('uiPreferences.favorites: pruned')
  }
  const hidden = recordOf(prefs['hiddenModels'])
  if (Object.hasOwn(hidden, removedProvider)) {
    const { [removedProvider]: _removed, ...rest } = hidden
    ops.push({ op: 'set', path: ['uiPreferences', 'hiddenModels'], value: rest as JsonValue })
    rewritten.push('uiPreferences.hiddenModels: pruned')
  }
  const order = arrayOf(prefs['providerOrder'])
  const keptOrder = order.filter(id => id !== removedProvider)
  if (keptOrder.length !== order.length) {
    ops.push({ op: 'set', path: ['uiPreferences', 'providerOrder'], value: keptOrder as JsonValue })
    rewritten.push('uiPreferences.providerOrder: pruned')
  }

  return { ops, rewritten, droppedChains }
}

/**
 * Plan the `agent-default-model` rewrite. The selection resets to the built-in
 * keyless Kilo route under the default baseline, to blanks under `off`, and a
 * `chain` naming a dropped group is cleared. A selection that does not name
 * the route and keeps a live group is left untouched.
 * @param value - the described `agent-default-model` value.
 * @param removedProvider - the deleted provider route id.
 * @param droppedChains - group ids the same cleanup pass deletes.
 * @returns the path operations; empty when nothing refers to the route.
 */
export function buildAgentDefaultModelOps(
  value: unknown,
  removedProvider: string,
  droppedChains: ReadonlySet<string>,
): SettingsPathOpView[] {
  const selection = recordOf(value)
  const ops: SettingsPathOpView[] = []
  const chain = stringOf(selection['chain'])
  if (chain !== undefined && droppedChains.has(chain)) ops.push({ op: 'unset', path: ['chain'] })
  if (selection['provider'] !== removedProvider) return ops
  const baseline = selection['baseline'] === 'off' ? 'off' : 'kilo'
  ops.push(
    { op: 'set', path: ['provider'], value: baseline === 'off' ? '' : WIZARD_FREE_PROVIDER },
    { op: 'set', path: ['model'], value: baseline === 'off' ? '' : WIZARD_FREE_MODEL },
  )
  return ops
}

/**
 * Plan the `subagent-model-selection` rewrite: allowed routes naming the route
 * are pruned, and an enabled selection that empties resets to the shipped off
 * state so session composition never reads an enabled-but-empty selection.
 * @param value - the described `subagent-model-selection` value.
 * @param removedProvider - the deleted provider route id.
 * @returns the path operations; empty when nothing refers to the route.
 */
export function buildSubagentSelectionOps(value: unknown, removedProvider: string): SettingsPathOpView[] {
  const selection = recordOf(value)
  const allowed = arrayOf(selection['allowedModels'])
  const kept = allowed.filter(route => !(isRecord(route) && route.provider === removedProvider))
  if (kept.length === allowed.length) return []
  const ops: SettingsPathOpView[] = [{ op: 'set', path: ['allowedModels'], value: kept as JsonValue }]
  if (kept.length === 0 && selection['enabled'] === true) ops.push({ op: 'set', path: ['enabled'], value: false })
  return ops
}

/** One namespace's freshly planned write. */
interface NamespacePlan {
  ops: readonly SettingsPathOpView[]
  labels: readonly string[]
}

/** One fenced namespace outcome: the failure, and the labels of the committed plan. */
interface FencedOutcome {
  error: GroupWriteFailure | null
  labels: readonly string[]
}

/**
 * Run one namespace's plan against the live document with revision fencing and
 * a bounded conflict retry that re-reads and replans each attempt. A namespace
 * with no operations is a no-op and never mutates.
 * @param api - the settings Remote face (describe + mutate).
 * @param ns - the namespace to rewrite.
 * @param plan - builds the operations from one fresh namespace view.
 * @returns the failure, or the labels of the plan that committed.
 */
async function applyFenced(
  api: Pick<ModelsWire, 'settings'>,
  ns: string,
  plan: (view: SettingsNamespaceView | undefined) => NamespacePlan,
): Promise<FencedOutcome> {
  const timeout: FencedOutcome = { error: { code: 'timeout' }, labels: [] }
  return withWriteTimeout((async (): Promise<FencedOutcome> => {
    for (let attempt = 0; attempt <= MAX_GROUP_WRITE_RETRIES; attempt++) {
      const described = await api.settings.describe()
      if (!described.ok) return { error: { code: 'unavailable', ...messageOf(described.error.message) }, labels: [] }
      const view = described.value.namespaces.find(candidate => candidate.ns === ns)
      const planned = plan(view)
      if (planned.ops.length === 0) return { error: null, labels: [] }
      const written = await api.settings.mutate(ns, [...planned.ops], view?.revision)
      if (written.ok) return { error: null, labels: planned.labels }
      if (written.error.code !== 'settings/conflict') {
        return { error: { code: 'rejected', ...messageOf(written.error.message) }, labels: [] }
      }
    }
    return { error: { code: 'conflict' }, labels: [] }
  })(), timeout)
}

/** Attach a host message only when it carries text. */
function messageOf(message: string): { message?: string } {
  return message === '' ? {} : { message }
}

/** What one route removal cleanup rewrote. */
export interface RemovedRouteCleanup {
  /** Labels of every rewritten reference; empty when the route had none. */
  readonly rewritten: readonly string[]
  /** The first write that did not land; null when every reference was reset. */
  readonly error: GroupWriteFailure | null
}

/**
 * Rewrite every reference to a deleted provider route back to its default.
 * Runs one fenced write per namespace (only when it has references to reset),
 * then prunes the picker's synchronous `localStorage` mirrors. A failure stops
 * at that namespace and reports the cause; already-committed namespaces stay
 * rewritten, and a retry of the same removal is a no-op for them.
 * @param api - the settings Remote face (describe + mutate).
 * @param removedProvider - the deleted provider route id.
 * @returns the rewrite labels and the first failure, when any.
 */
export async function cleanupRemovedRoute(
  api: Pick<ModelsWire, 'settings'>,
  removedProvider: string,
): Promise<RemovedRouteCleanup> {
  if (removedProvider === '') return { rewritten: [], error: null }
  const rewritten: string[] = []
  let droppedChains: ReadonlySet<string> = new Set()

  const orchestration = await applyFenced(api, ORCHESTRATION_NS, (view) => {
    const planned = buildOrchestrationPlan(view?.value, removedProvider)
    droppedChains = planned.droppedChains
    return { ops: planned.ops, labels: planned.rewritten }
  })
  if (orchestration.error !== null) return { rewritten, error: orchestration.error }
  rewritten.push(...orchestration.labels)
  // The preferences live in the namespace that just committed: their local
  // mirrors must follow even when a later namespace write fails.
  pruneLocalMirrors(removedProvider)

  const agent = await applyFenced(api, AGENT_DEFAULT_MODEL_NS, (view) => {
    const ops = buildAgentDefaultModelOps(view?.value, removedProvider, droppedChains)
    return { ops, labels: ops.length === 0 ? [] : [`${AGENT_DEFAULT_MODEL_NS}: reset`] }
  })
  if (agent.error !== null) return { rewritten, error: agent.error }
  rewritten.push(...agent.labels)

  const subagent = await applyFenced(api, SUBAGENT_MODEL_SELECTION_NS, (view) => {
    const ops = buildSubagentSelectionOps(view?.value, removedProvider)
    return { ops, labels: ops.length === 0 ? [] : [`${SUBAGENT_MODEL_SELECTION_NS}: pruned`] }
  })
  if (subagent.error !== null) return { rewritten, error: subagent.error }
  rewritten.push(...subagent.labels)
  return { rewritten, error: null }
}

/** Prune the `localStorage` mirrors the picker and the models page read synchronously. */
function pruneLocalMirrors(removedProvider: string): void {
  rewriteStored(FAVORITES_KEY, parsed => Array.isArray(parsed)
    ? parsed.filter(entry => !(isRecord(entry) && entry.provider === removedProvider))
    : parsed)
  rewriteStored(PROVIDER_ORDER_KEY, parsed => Array.isArray(parsed)
    ? parsed.filter(id => id !== removedProvider)
    : parsed)
  forgetHiddenProvider(removedProvider)
  /* v8 ignore next 2 -- a client plugin bundle only ever runs in a browser window. */
  if (typeof window === 'undefined') return
  try {
    // Any picker surface re-reads the now-pruned group registry from the host.
    window.dispatchEvent(new CustomEvent(GROUPS_CHANGED_EVENT))
  } catch {
    // A hostile window stub must not fail a completed cleanup.
  }
}

/**
 * Rewrite one `localStorage` JSON document through `prune`, dispatching the
 * picker's change event only when the stored text actually moves. Storage
 * being disabled and a malformed mirror are no-ops: the server document is
 * authoritative and the mirror self-heals on the next load.
 */
function rewriteStored(key: string, prune: (parsed: unknown) => unknown): void {
  /* v8 ignore next 2 -- a client plugin bundle only ever runs in a browser window. */
  if (typeof window === 'undefined') return
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return
    const serialized = JSON.stringify(prune(JSON.parse(raw)))
    if (serialized === raw) return
    window.localStorage.setItem(key, serialized)
    window.dispatchEvent(new CustomEvent(PREFS_CHANGED_EVENT, { detail: { key } }))
  } catch {
    // Storage disabled, quota, or a malformed mirror: nothing to prune safely.
  }
}

/**
 * Localize why the reference cleanup did not commit. The host's own diagnostic
 * is shown verbatim when present; otherwise the cause code maps to dictionary
 * copy. A caller without a translate seat falls back to the machine code.
 * @param t - the Models section translate, when bound.
 * @param failure - the cleanup write failure.
 * @returns the text the delete dialog shows.
 */
export function cleanupFailureText(
  t: ((key: keyof typeof en) => string) | undefined,
  failure: GroupWriteFailure,
): string {
  if (failure.message !== undefined && failure.message !== '') return failure.message
  if (t === undefined) return failure.code
  switch (failure.code) {
    case 'unavailable': return t('cleanupUnavailable')
    case 'conflict': return t('cleanupConflict')
    case 'timeout': return t('cleanupTimeout')
    case 'rejected': return t('cleanupRejected')
  }
}
