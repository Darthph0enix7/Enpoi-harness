import type { Context } from '@deepseek-ai/cordis'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-session/types'
import { trajectoryNode } from './trajectory-definition-common.ts'
import type {
  TrajectoryRevertBoundary, TrajectoryRevertConflict, TrajectoryRevertFileResult,
} from './trajectory-contract.ts'

/**
 * Read the recorded trigger. Logs written before `cause` existed record only
 * `fromSeq`, where a null boundary is a restore (mirrors the file-revert reader).
 * @param fromSeq - boundary anchor from the durable event.
 * @param cause - recorded trigger, when present.
 * @returns the boundary trigger.
 */
function revertCause(
  fromSeq: number | null,
  cause: 'revert' | 'restore' | 'commit' | undefined,
): TrajectoryRevertBoundary['cause'] {
  if (cause !== undefined) return cause
  return fromSeq === null ? 'restore' : 'revert'
}

/** Durable revert boundaries as first-class Trajectory records. */
const trajectoryRevertDefinition: ConversationNodeDefinition<TrajectoryRevertBoundary> = {
  kind: 'trajectory-revert',
  target: 'trajectory',
  match: event => event.type === 'revert/state'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'revert/state') {
      throw new Error('trajectory-revert start requires revert/state')
    }
    const fromSeq = match.event.data.fromSeq
    return {
      seq: match.event.seq,
      time: match.event.time,
      fromSeq: typeof fromSeq === 'number' ? fromSeq : null,
      cause: revertCause(typeof fromSeq === 'number' ? fromSeq : null, match.event.data.cause),
    }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : trajectoryNode(context, context.state.seq, { kind: 'revert', revert: context.state }),
}

/** Durable per-file revert outcome batches as first-class Trajectory records. */
const trajectoryRevertFilesDefinition: ConversationNodeDefinition<TrajectoryRevertFileResult> = {
  kind: 'trajectory-revert-files',
  target: 'trajectory',
  match: event => event.type === 'revert/file-result'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'revert/file-result') {
      throw new Error('trajectory-revert-files start requires revert/file-result')
    }
    return {
      seq: match.event.seq,
      revertSeq: match.event.data.revertSeq,
      outcomes: match.event.data.outcomes,
    }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : trajectoryNode(context, context.state.seq, { kind: 'revert-files', files: context.state }),
}

/** Durable file-revert conflicts awaiting operator resolution. */
const trajectoryRevertConflictDefinition: ConversationNodeDefinition<TrajectoryRevertConflict> = {
  kind: 'trajectory-revert-conflict',
  target: 'trajectory',
  match: event => event.type === 'revert/file-conflict'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'revert/file-conflict') {
      throw new Error('trajectory-revert-conflict start requires revert/file-conflict')
    }
    const data = match.event.data
    return {
      seq: match.event.seq,
      conflictId: data.conflictId,
      targetKey: data.targetKey,
      displayPath: data.displayPath,
      state: data.state,
      ...(data.boundarySeq === undefined ? {} : { boundarySeq: data.boundarySeq }),
    }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : trajectoryNode(context, context.state.seq, {
      kind: 'revert-conflict',
      conflict: context.state,
    }),
}

/**
 * Register Trajectory-owned revert boundary, file-result, and conflict records.
 *
 * @param ctx - Plugin context receiving the Definitions.
 */
export function registerTrajectoryRevertDefinition(ctx: Context): void {
  ctx.uiConversation.events.register(trajectoryRevertDefinition)
  ctx.uiConversation.events.register(trajectoryRevertFilesDefinition)
  ctx.uiConversation.events.register(trajectoryRevertConflictDefinition)
}
