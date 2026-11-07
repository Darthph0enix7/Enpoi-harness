/** Native V4 metadata and generation-owned relationship validation. */

import { isAbsolute } from 'node:path'
import { SessionFormatError, SessionFormatUnsupportedMigrationError, isSessionFormatJsonObject, sessionFormatCount } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { assertV4DeveloperData } from './developer.ts'
import { assertV4LifecycleRelationships } from './relationships.ts'
import { assertV4MessageSources } from './message-sources.ts'
import { catalogFact } from './facts.ts'
import { assertV4RetiredSyntax } from './retired-syntax.ts'
import { assertV4SystemMessageFields } from './system-message.ts'
import { assertV4ForkResult } from './fork-result.ts'
import { assertV4ToolResultMessage } from './tool-role.ts'

/**
 * Validate one released logical Session header with the shared field set.
 * @param header - decoded or otherwise untrusted header candidate.
 * @param version - exact logical format version the header must declare.
 */
export function assertReleasedSessionHeader(header: unknown, version: number): void {
  const label = `format v${version}`
  if (!isSessionFormatJsonObject(header) || header['version'] !== version) throw new SessionFormatError(`expected ${label} header`)
  const required = ['version', 'id', 'createdAt', 'isSeeded', 'delegationDepth']
  const allowed = new Set([...required, 'cwd', 'parentSession', 'origin', 'agentPreset'])
  const missing = required.find(key => !Object.hasOwn(header, key))
  const unexpected = Object.keys(header).find(key => !allowed.has(key))
  if (missing !== undefined) throw new SessionFormatError(`${label} header lacks required field ${missing}`)
  if (unexpected !== undefined) throw new SessionFormatError(`${label} header has unexpected field ${unexpected}`)
  if (typeof header.id !== 'string') throw new SessionFormatError(`${label} header id must be a string`)
  sessionFormatCount(header.createdAt, `${label} header createdAt`)
  sessionFormatCount(header.delegationDepth, `${label} header delegationDepth`)
  if (typeof header.isSeeded !== 'boolean') throw new SessionFormatError(`${label} header isSeeded must be boolean`)
  if (header.cwd !== undefined && (typeof header.cwd !== 'string' || !isAbsolute(header.cwd))) {
    throw new SessionFormatError(`${label} header cwd must be absolute`)
  }
  for (const key of ['parentSession', 'agentPreset']) {
    if (header[key] !== undefined && typeof header[key] !== 'string') {
      throw new SessionFormatError(`${label} header ${key} must be a string`)
    }
  }
  if (header.origin !== undefined && header.origin !== 'subagent') {
    throw new SessionFormatError(`${label} header origin must be "subagent"`)
  }
}

/**
 * Validate the exact native V4 logical header.
 * @param header - decoded or otherwise untrusted V4 Session header candidate.
 */
export function assertReleasedV4Header(header: unknown): void {
  assertReleasedSessionHeader(header, 4)
}

/**
 * Validate released inheritance, vocabulary, native message admission, and
 * lifecycle, compaction, tool, retry, title, command, catalog, and delivery ownership.
 * Installed Session restoration owns common event envelopes and message acceptance.
 * @param artifact - complete detached artifact.
 * @param knownEventTypes - event types understood by the installed Session package.
 * @param currentVersion - exact logical version this artifact must declare.
 * @param validateHeader - header validator for `currentVersion`.
 * @returns the same validated artifact and event objects.
 */
export function restoreReleasedArtifact(
  artifact: SessionFormatArtifact,
  knownEventTypes: ReadonlySet<string>,
  currentVersion: number,
  validateHeader: (header: unknown) => void,
): SessionFormatArtifact {
  validateHeader(artifact.header)
  const label = `format v${currentVersion}`
  const cut = sessionFormatCount(artifact.inheritedEventCount, `${label} inherited event count`)
  if (cut > artifact.events.length) throw new SessionFormatError(`${label} inherited event count exceeds its events`)
  if (!artifact.header.isSeeded && cut !== 0) throw new SessionFormatError(`unseeded ${label} Session has inherited events`)
  let lastInheritedMarker: number | undefined
  for (const [index, event] of artifact.events.entries()) {
    if (!knownEventTypes.has(event.type) && event['ignorable'] !== true) {
      throw new SessionFormatUnsupportedMigrationError(
        `${label} contains unknown event type ${JSON.stringify(event.type)} at seq ${index}`,
      )
    }
    if (event.seq !== index) throw new SessionFormatError(`${label} event ${index} is not dense`)
    if (!knownEventTypes.has(event.type)) continue
    assertV4RetiredSyntax(event)
    assertV4SystemMessageFields(event)
    assertV4ToolResultMessage(event)
    assertV4ForkResult(event)
    if (event.type === 'session/end-seed' && isSessionFormatJsonObject(event.data)
      && event.data['inherited'] === true) lastInheritedMarker = index
  }
  if (artifact.header.isSeeded && lastInheritedMarker !== cut) {
    throw new SessionFormatError(`${label} seeded header disagrees with its last inherited end-seed marker`)
  }
  if (!artifact.header.isSeeded && lastInheritedMarker !== undefined) {
    throw new SessionFormatError(`${label} unseeded Session contains an inherited end-seed marker`)
  }
  assertReleasedRelationships(artifact, knownEventTypes, currentVersion)
  return artifact
}

/**
 * Validate a released artifact as native V4 with the V4 delivery generation.
 * @param artifact - complete detached V4 artifact.
 * @param knownEventTypes - event types understood by the installed Session package.
 * @returns the same validated artifact and event objects.
 */
export function restoreReleasedV4Artifact(artifact: SessionFormatArtifact, knownEventTypes: ReadonlySet<string>): SessionFormatArtifact {
  return restoreReleasedArtifact(artifact, knownEventTypes, 4, assertReleasedV4Header)
}

/**
 * Validate delivery generation and active-generation coordinates before evaluating ownership.
 * @param event - decoded event whose delivery payload may be inspected.
 * @param currentVersion - generation whose watermark coordinates are active.
 * @returns the active delivery's nonempty Session id, or undefined for other events and generations.
 */
export function validateDeliveryAccepted(event: SessionFormatEvent, currentVersion: number): string | undefined {
  if (event.type !== 'session-log-deepseek/delivery-accepted') return undefined
  const data = event.data
  if (!isSessionFormatJsonObject(data)) throw new SessionFormatError('delivery-accepted data must be an object')
  const version = sessionFormatCount(data['sessionFormatVersion'] === undefined ? 0 : data['sessionFormatVersion'], 'delivery sessionFormatVersion')
  if (version !== currentVersion) return undefined
  const throughSeq = sessionFormatCount(data['throughSeq'], 'delivery throughSeq')
  if (throughSeq >= event.seq) throw new SessionFormatError('delivery throughSeq must precede its marker')
  const id = data['sessionId']
  if (typeof id !== 'string' || id.length === 0) throw new SessionFormatError('delivery requires a nonempty Session id')
  return id
}

/**
 * Validate native developer fields, message sources, lifecycle, catalog, and delivery
 * relationships without changing event vocabulary or tail recovery.
 * The owning admission stage rejects unknown required events;
 * unknown ignorable records retain their uninterpreted payloads.
 * @param artifact - decoded artifact with its final inherited cut.
 * @param knownEventTypes - installed event types whose payloads this reader interprets.
 */
export function assertReleasedV4Relationships(artifact: SessionFormatArtifact, knownEventTypes: ReadonlySet<string>): void {
  assertReleasedRelationships(artifact, knownEventTypes, 4)
}

/**
 * Validate native message sources, catalog uniqueness, current-generation delivery
 * ownership, and lifecycle relationships for one released artifact.
 * @param artifact - decoded artifact with its final inherited cut.
 * @param knownEventTypes - installed event types whose payloads this reader interprets.
 * @param currentVersion - generation whose delivery watermark coordinates are active.
 */
export function assertReleasedRelationships(
  artifact: SessionFormatArtifact,
  knownEventTypes: ReadonlySet<string>,
  currentVersion: number,
): void {
  const ids = new Set<string>()
  for (const event of artifact.events) {
    if (!knownEventTypes.has(event.type)) continue
    assertV4DeveloperData(event)
    assertV4MessageSources(event)
    const deliveryId = validateDeliveryAccepted(event, currentVersion)
    if (deliveryId !== undefined
      && !(artifact.header.parentSession !== undefined && event.seq < artifact.inheritedEventCount)
      && deliveryId !== artifact.header.id) {
      throw new SessionFormatError('current-generation delivery marker names the wrong Session')
    }
    if (event.type === 'subagent/catalog' && event.seq >= artifact.inheritedEventCount) {
      const fact = catalogFact(event.data)
      const id = fact['childId'] as string
      if (ids.has(id)) throw new SessionFormatError(`duplicate catalog child ${id}`)
      ids.add(id)
    }
  }
  assertV4LifecycleRelationships(artifact, knownEventTypes)
}
