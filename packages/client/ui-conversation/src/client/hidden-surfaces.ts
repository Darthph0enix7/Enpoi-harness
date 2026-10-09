/**
 * Duplicate-surface preference: conversation view tabs the operator hides.
 *
 * The list lives at `enpoi-orchestration.uiPreferences.hiddenSurfaces.views`
 * and follows the profile's client prefs pattern (ui-settings-models/hidden-models):
 * a synchronous localStorage cache the view roster reads on every derivation,
 * a local publish, and `refreshFromServer` re-reading the namespace on boot and
 * after a `settings/document-updated` push. The duplicate-surface decision is
 * the default: dsh-context-lens's "Request Context" tab is hidden until an
 * operator writes a different list; an empty list restores every registered
 * view, no code change and no reload of the plugin.
 *
 * The read/publish machinery is the shared
 * `@deepseek-ai/dsh-client-ui-primitives` partition (one factory, per-roster
 * cache key and default); this module owns only the conversation view wiring.
 */
import { createHiddenSurfaces } from '@deepseek-ai/dsh-client-ui-primitives'

const surfaces = createHiddenSurfaces({
  storageKey: 'dsh_hidden_surfaces_views_v1',
  defaultList: ['context-lens'],
  pick: 'views',
})

/**
 * Re-read the namespace and adopt the operator's list (cross-device sync). A
 * namespace without a `hiddenSurfaces` value keeps the last local snapshot, so
 * the shipped default stands until an operator writes the preference; a
 * `hiddenSurfaces` object without a `views` list means nothing is hidden.
 */
export const { refreshHiddenSurfaces, subscribeHiddenSurfaces } = surfaces

/**
 * The conversation view ids the tab roster must not surface.
 * @returns the hidden view ids in force.
 */
export function getHiddenConversationViews(): ReadonlySet<string> {
  return surfaces.getHidden()
}

/**
 * Whether one registered view id is hidden right now.
 * @param id - the `conversation.view` entry id.
 * @returns whether the view is hidden.
 */
export function isConversationViewHidden(id: string): boolean {
  return surfaces.isHidden(id)
}

// Global server sync on module import: the cache serves the first paint.
if (typeof window !== 'undefined') {
  void surfaces.refreshHiddenSurfaces()
}
