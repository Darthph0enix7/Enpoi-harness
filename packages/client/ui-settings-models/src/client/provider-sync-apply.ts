/**
 * Replace-semantics application of one provider-sync refresh answer to a
 * route's stored models, shared by the Models page's manual catalog refresh
 * and the Add-provider flow's post-discovery convergence so both surfaces
 * persist the same canonical membership.
 *
 * @module ui-settings-models/provider-sync-apply
 */

/** The minimum a current stored row must carry for the replace merge: its id. */
export type RefreshedCurrentRow = { id: string }

/**
 * Apply one host refresh answer to the route's current models with replace
 * semantics: the answer is the base, and a current row absent from it is kept
 * unless the host named its id in `removed`. The host's removal list is the
 * sole deletion gate, so an omitted row the host never reported — a row the
 * panel is still drafting, or one another writer added mid-refresh — survives
 * with its own fields and stamp, while a `source: 'manual'` row keeps its
 * stamp either way.
 * @param current - the route's models as the caller currently holds them.
 * @param answer - the host pipeline's planned records.
 * @param removed - the ids the host reported as removed.
 * @returns the list to persist (the answer, plus surviving current rows).
 */
export function applyRefreshedModels(
  current: readonly RefreshedCurrentRow[],
  answer: readonly Record<string, unknown>[],
  removed: readonly string[],
): Array<Record<string, unknown>> {
  const answerIds = new Set(answer.map(model => (typeof model.id === 'string' ? model.id : '')))
  const removedIds = new Set(removed)
  const survivors = current.filter(model => !answerIds.has(model.id) && !removedIds.has(model.id))
  return [...answer, ...survivors]
}
