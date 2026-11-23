/**
 * Cross-provider model identity for the picker.
 *
 * Selection and persistence are always provider+model keyed. Rows are grouped
 * by provider, but the same display name or model id can be offered by several
 * providers, and a search or the selected-model trigger drops the group header
 * that used to disambiguate them. The collision set therefore covers the full
 * loaded catalogue — never the current filtered list — so a row's visible
 * provider tag and the trigger label do not change while the user types.
 */

/** One provider group reduced to the fields the collision rule reads. */
export interface ProviderModelCatalog {
  id: string
  models: readonly { id: string; name: string }[]
}

/**
 * Key one provider/model pair for identity lookups.
 * @param provider - provider id.
 * @param modelId - model id within that provider.
 * @returns the opaque composite key.
 */
export function modelRowKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`
}

/**
 * Whether a display name or model id is unique per provider.
 * @param value - display name or model id.
 * @returns the normalized comparison key.
 */
function normalize(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Collect the provider/model pairs whose display name or id collides with a row
 * offered by another provider.
 * @param groups - every loaded provider group, in catalogue order.
 * @returns provider/model keys that need an identifying provider tag.
 */
export function ambiguousModelKeys(
  groups: readonly ProviderModelCatalog[],
): ReadonlySet<string> {
  const rowsByName = new Map<string, Map<string, string[]>>()
  const rowsById = new Map<string, Map<string, string[]>>()
  const remember = (
    index: Map<string, Map<string, string[]>>,
    value: string,
    provider: string,
    key: string,
  ): void => {
    let providers = index.get(value)
    if (providers === undefined) {
      providers = new Map()
      index.set(value, providers)
    }
    let keys = providers.get(provider)
    if (keys === undefined) {
      keys = []
      providers.set(provider, keys)
    }
    keys.push(key)
  }
  for (const group of groups) {
    for (const model of group.models) {
      const key = modelRowKey(group.id, model.id)
      remember(rowsByName, normalize(model.name), group.id, key)
      remember(rowsById, normalize(model.id), group.id, key)
    }
  }
  const collisions = new Set<string>()
  for (const index of [rowsByName, rowsById]) {
    for (const providers of index.values()) {
      if (providers.size < 2) continue
      for (const keys of providers.values()) {
        for (const key of keys) collisions.add(key)
      }
    }
  }
  return collisions
}
