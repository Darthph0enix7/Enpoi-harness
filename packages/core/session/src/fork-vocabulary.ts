/**
 * Installed-Enpoi-fork event vocabulary and the `plugin:` namespace tolerance
 * shared by every installed reader.
 *
 * A reader that does not know an ignorable event namespaces it to
 * `plugin:<original>` (see the V3→V4 `namespaceV3OpaqueEvent`). The fork's own
 * readers fold their vocabulary by the exact original name, so this module
 * restores that name on adoption. The same list gates admission in the
 * migration edge; keep both copies in step
 * (`packages/session/session-format-v3-to-v4/src/extension-identities.ts`).
 * @module @deepseek-ai/dsh-session/fork-vocabulary
 */

/**
 * Fork-owned event types outside the released upstream inventory. `llm/attempt-failed`,
 * `verify/unmet`, and `oracle/verdict-committed` are owner-emitted records; the first
 * two are declared in `SessionEventMap` for the V4 vocabulary (generated-catalog
 * regeneration pending) and remain listed so logs written before that declaration keep
 * their exact names. `capability/toggled` is reserved for the deferred per-session
 * capability projection and has no live emitter.
 */
export const FORK_OWNED_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'brief/prose-updated',
  'brief/blocker',
  'brief/decision',
  'brief/files',
  'brief/phase-updated',
  'claim/intake',
  'claim/graduated',
  'claim/rescinded',
  'claim/untrusted-pending',
  'council/started',
  'council/round',
  'council/finished',
  'llm/attempt-failed',
  'oracle/verdict-committed',
  'revert/state',
  'revert/file-intent',
  'revert/file-result',
  'revert/file-conflict',
  'state/checkpoint',
  'verify/unmet',
  'capability/toggled',
])

/**
 * Return the installed event type a stored record names. A record namespaced
 * `plugin:<fork-type>` is restored to the fork-owned name so installed readers
 * fold it; every other type, namespaced or not, is returned unchanged.
 * @param type - stored event type.
 * @returns the fork-owned original name, or `type` unchanged.
 */
export function forkOwnedEventType(type: string): string {
  if (!type.startsWith('plugin:')) return type
  const original = type.slice('plugin:'.length)
  return FORK_OWNED_SESSION_EVENT_TYPES.has(original) ? original : type
}
