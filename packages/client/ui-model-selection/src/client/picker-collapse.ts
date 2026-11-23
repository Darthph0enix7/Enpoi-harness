/**
 * Collapse state for the model picker's sections.
 *
 * The saved preference (`dsh_collapsed_groups_v2`) is the user's own state
 * outside a search. A search temporarily expands every section that has a
 * match; a section the user collapses or expands during that query keeps that
 * choice until the query is cleared. The saved preference is never rewritten
 * by search-time toggles, so clearing the search restores the pre-search view
 * exactly.
 */

/** One section id: a provider id or a built-in section marker. */
export type PickerSectionId = string

/** Explicit user choices made while one search query is active. */
export type SearchCollapseToggles = ReadonlyMap<PickerSectionId, boolean>

/**
 * Resolve whether one section renders collapsed.
 * @param section - section id.
 * @param searching - whether a non-empty search query is active.
 * @param saved - the persistent collapsed-section set.
 * @param toggles - explicit choices made during the active query.
 * @returns true when the section body is hidden.
 */
export function resolveSectionCollapsed(
  section: PickerSectionId,
  searching: boolean,
  saved: ReadonlySet<PickerSectionId>,
  toggles: SearchCollapseToggles,
): boolean {
  if (!searching) return saved.has(section)
  return toggles.get(section) ?? false
}

/**
 * Record one explicit search-time toggle without mutating the previous map.
 * @param toggles - current search-time choices.
 * @param section - section the user toggled.
 * @returns a new map whose section is flipped.
 */
export function toggleSearchCollapse(
  toggles: SearchCollapseToggles,
  section: PickerSectionId,
): SearchCollapseToggles {
  const next = new Map(toggles)
  next.set(section, !(toggles.get(section) ?? false))
  return next
}
