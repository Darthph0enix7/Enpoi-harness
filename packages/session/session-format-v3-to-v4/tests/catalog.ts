/** Fixed V0–V4 composition for released-edge tests, independent of the current writer. */

import { KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { createSessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatCatalog, SessionFormatHeader, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { releasedV0SessionFormatCodec, sessionFormatV0ToV1 } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { releasedV1SessionFormatCodec, sessionFormatV1ToV2 } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { releasedV2SessionFormatCodec, sessionFormatV2ToV3 } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { assertReleasedV4Header, createSessionFormatV3ToV4, releasedV3SessionFormatCodec, releasedV4SessionFormatCodec, restoreReleasedV4Artifact } from '../src/index.ts'

/**
 * Restore a released V4 result through its complete predecessor chain.
 * @param children - parent-specific child evidence retained unchanged for the catalog's lifetime.
 * @returns a V4-target catalog whose readers never migrate past the released V4 writer.
 */
export function v4CatalogWithChildren(children: readonly SessionFormatJsonValue[]): SessionFormatCatalog {
  return createSessionFormatCatalog({
    currentVersion: 4,
    codecs: [
      releasedV0SessionFormatCodec,
      releasedV1SessionFormatCodec,
      releasedV2SessionFormatCodec,
      releasedV3SessionFormatCodec,
      releasedV4SessionFormatCodec,
    ],
    currentEncoder: releasedV4SessionFormatCodec,
    migrations: [sessionFormatV0ToV1, sessionFormatV1ToV2, sessionFormatV2ToV3, createSessionFormatV3ToV4(children)],
    restoreCurrent: artifact => restoreReleasedV4Artifact(artifact, KNOWN_SESSION_EVENT_TYPES),
    restoreTransformedCurrent: artifact => restoreReleasedV4Artifact(artifact, KNOWN_SESSION_EVENT_TYPES),
    restoreCurrentHeader(header) {
      assertReleasedV4Header(header)
      return header
    },
  })
}

/** V4-target catalog with no historical child evidence. */
export const v4Catalog = v4CatalogWithChildren([])

/**
 * Stamp a released V4 logical header as the installed current Session header.
 * @param header - validated released header whose body the current Session adopts.
 * @returns the same metadata with the current version and branded ids.
 */
export function currentSessionHeader(header: SessionFormatHeader): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(header.id),
    createdAt: header.createdAt,
    ...header.cwd === undefined ? {} : { cwd: header.cwd },
    ...header.parentSession === undefined ? {} : { parentSession: SessionId(header.parentSession) },
    isSeeded: header.isSeeded,
    ...header.origin === undefined ? {} : { origin: header.origin },
    delegationDepth: header.delegationDepth,
    ...header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset },
  }
}
