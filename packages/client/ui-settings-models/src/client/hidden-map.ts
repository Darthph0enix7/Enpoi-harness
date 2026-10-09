/**
 * The canonical hidden-model map rule shared by the picker store
 * (`hidden-models.ts`) and the route-removal cleanup (`route-references.ts`):
 * one route's entry is its non-empty list of hidden model ids, so an empty
 * list is absent rather than stored as `[]`. Readers use `Object.hasOwn`, and
 * a saved `{ route: [] }` from an older writer is rewritten to the canonical
 * form by the next write of that document.
 *
 * @module ui-settings-models/hidden-map
 */

/**
 * The map after one provider's hidden list is set. An empty list removes the
 * provider key; a non-empty list replaces it. Other entries are preserved.
 * @param map - the current map document.
 * @param provider - the provider route key.
 * @param ids - the provider's hidden model ids.
 * @returns the rewritten map.
 */
export function withHiddenList(
  map: Record<string, unknown>,
  provider: string,
  ids: readonly string[],
): Record<string, unknown> {
  const { [provider]: _previous, ...rest } = map
  return ids.length === 0 ? rest : { ...rest, [provider]: [...ids] }
}

/**
 * Drop every provider key that carries an empty list, so a map left in the
 * non-canonical form is normalized. A malformed (non-array) entry is
 * preserved: only the canonical empty-list rule is applied here.
 * @param map - the current map document.
 * @returns the canonical map; the input reference when no entry moves.
 */
export function canonicalizeHiddenMap(map: Record<string, unknown>): Record<string, unknown> {
  const emptyKeys = new Set(
    Object.entries(map)
      .filter(([, ids]) => Array.isArray(ids) && ids.length === 0)
      .map(([provider]) => provider),
  )
  if (emptyKeys.size === 0) return map
  return Object.fromEntries(Object.entries(map).filter(([provider]) => !emptyKeys.has(provider)))
}
