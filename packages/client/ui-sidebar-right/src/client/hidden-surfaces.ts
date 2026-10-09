/**
 * Duplicate-surface preference: right-sidebar page kinds the operator hides.
 *
 * The list lives at `enpoi-orchestration.uiPreferences.hiddenSurfaces.sidebarRight`
 * and follows the profile's client prefs pattern (ui-settings-models/hidden-models):
 * a synchronous localStorage cache the registry reads on every derivation, a
 * local publish, and `refreshFromServer` re-reading the namespace on boot and
 * after a `settings/document-updated` push. The duplicate-surface decision is
 * the default: dsh-context's Context page is hidden until an operator writes a
 * different list; an empty list restores every registered kind, no code change
 * and no reload of the plugin.
 *
 * The read/publish machinery is the shared
 * `@deepseek-ai/dsh-client-ui-primitives` partition (one factory, per-roster
 * cache key and default); this module owns only the page-kind wiring.
 */
import { createHiddenSurfaces } from '@deepseek-ai/dsh-client-ui-primitives'

const surfaces = createHiddenSurfaces({
  storageKey: 'dsh_hidden_surfaces_sidebar_right_v1',
  defaultList: ['dsh-context'],
  pick: 'sidebarRight',
})

/**
 * Re-read the namespace and adopt the operator's list (cross-device sync). A
 * namespace without a `hiddenSurfaces` value keeps the last local snapshot, so
 * the shipped default stands until an operator writes the preference; a
 * `hiddenSurfaces` object without a `sidebarRight` list means nothing is hidden.
 */
export const { refreshHiddenSurfaces, subscribeHiddenSurfaces } = surfaces

/**
 * The page kinds the right sidebar must not surface.
 * @returns the hidden kinds in force.
 */
export function getHiddenSidebarRightKinds(): ReadonlySet<string> {
  return surfaces.getHidden()
}

/**
 * Whether one page kind is hidden right now.
 * @param kind - the registered tab kind.
 * @returns whether the kind is hidden.
 */
export function isSidebarRightKindHidden(kind: string): boolean {
  return surfaces.isHidden(kind)
}

// Global server sync on module import: the cache serves the first paint.
if (typeof window !== 'undefined') {
  void surfaces.refreshHiddenSurfaces()
}
