/** Native V5 metadata and generation-owned relationship validation. */

import type { SessionFormatArtifact } from '@deepseek-ai/dsh-session-format'
import {
  assertReleasedRelationships,
  assertReleasedSessionHeader,
  restoreReleasedArtifact,
} from '@deepseek-ai/dsh-session-format-v3-to-v4'

/**
 * Validate the exact native V5 logical header.
 * @param header - decoded or otherwise untrusted V5 Session header candidate.
 */
export function assertReleasedV5Header(header: unknown): void {
  assertReleasedSessionHeader(header, 5)
}

/**
 * Validate V5 inheritance, vocabulary, native message admission, and
 * lifecycle, compaction, tool, retry, title, command, catalog, and delivery ownership.
 * Installed Session restoration owns common event envelopes and message acceptance.
 * @param artifact - complete detached V5 artifact.
 * @param knownEventTypes - event types understood by the installed Session package.
 * @returns the same validated artifact and event objects.
 */
export function restoreReleasedV5Artifact(
  artifact: SessionFormatArtifact,
  knownEventTypes: ReadonlySet<string>,
): SessionFormatArtifact {
  return restoreReleasedArtifact(artifact, knownEventTypes, 5, assertReleasedV5Header)
}

/**
 * Validate native message sources, catalog uniqueness, current-generation delivery
 * ownership, and lifecycle relationships for one released V5 artifact.
 * @param artifact - decoded artifact with its final inherited cut.
 * @param knownEventTypes - installed event types whose payloads this reader interprets.
 */
export function assertReleasedV5Relationships(
  artifact: SessionFormatArtifact,
  knownEventTypes: ReadonlySet<string>,
): void {
  assertReleasedRelationships(artifact, knownEventTypes, 5)
}
