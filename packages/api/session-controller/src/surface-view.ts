/**
 * Plugin-agnostic surface node folding for host diagnostics.
 *
 * `foldSurface` requires an interpreter for every declared message projection
 * because a projection may change model-visible content. The host read paths
 * here only need the ordered node list, which a projection never changes, so
 * an identity interpreter keeps the fold available without mounting the
 * owning plugin.
 *
 * @module
 */

import { foldSurface } from '@deepseek-ai/dsh-session'
import { MESSAGE_PROJECTION_EVENT_TYPES } from '@deepseek-ai/dsh-session/src/known-event-types.ts'
import type { SessionEvent, SessionMessageProjection, SessionSeq } from '@deepseek-ai/dsh-session'

/**
 * Identity interpreters for every declared message-projection type. A
 * projection only updates projected message content; the surface node order is
 * unchanged, which is all these callers consume.
 */
const NODE_VIEW_PROJECTIONS: readonly SessionMessageProjection[] =
  [...MESSAGE_PROJECTION_EVENT_TYPES].map(type => ({
    type: type as SessionMessageProjection['type'],
    project: () => new Map(),
  }))

/**
 * Fold the model-visible surface node sequences over one durable log without
 * requiring any plugin's message projection to be mounted.
 * @param events - dense zero-based durable events.
 * @returns the surface node seqs in model-visible order.
 * @throws when the log's surface transitions are invalid.
 */
export function foldSurfaceNodes(events: readonly SessionEvent[]): readonly SessionSeq[] {
  return foldSurface(events, NODE_VIEW_PROJECTIONS).nodes
}
