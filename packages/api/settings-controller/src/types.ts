/**
 * Browser-safe failure vocabulary of the configuration surfaces this package
 * serves. The redacted views themselves live with their seam in
 * `@deepseek-ai/dsh-settings/types`, whose Cordis event declarations already
 * register that file for the Client compilation face.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * Every seam refusal that is not a stale write: an unregistered or malformed
     * namespace, a read-only provider, schema validation, storage.
     */
    'settings/rejected': { readonly ns: string }
    /**
     * The stored revision moved after the caller read it. Its own outcome rather
     * than an invalid request: the caller must re-read and re-apply.
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /**
     * The provider refused a valid credential write, for example because a
     * read-only source shadows the reference. The details name only the
     * reference, never the value.
     */
    'credential/rejected': { readonly ref: string }
  }
}

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}

/**
 * One published settings artifact read. `value` is present only when the
 * artifact's revision differs from the `knownRevision` the caller sent, so a
 * repeat read of an unchanged artifact answers without the payload.
 */
export interface SettingsArtifactView {
  /** Artifact name the caller asked for. */
  readonly key: string
  /** Current artifact revision; moves only when a publish changed the value. */
  readonly revision: number
  /** Whether this read carries a value the caller had not seen. */
  readonly changed: boolean
  /** The published value; absent when `changed` is false. */
  readonly value?: JsonValue
}
