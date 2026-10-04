/**
 * dsh-enpoi-tool-groups — the durable attached-set projection.
 *
 * The meta-tool appends `tool-groups/change` with the COMPLETE post-change
 * attached set (whole-value event rule); this unit folds it into the host
 * state read by the presentation filter, the menu, and the tool. Because the
 * projection registry restores cells by folding the session log on first
 * touch, a resumed session comes back with exactly the set it had — nothing
 * silently un-attaches across sessions.
 *
 * @module dsh-enpoi-tool-groups/projection
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Durable attached-group set change. Carries the complete post-change set;
     * `ignorable` so a build that predates this event can still read the log.
     */
    'tool-groups/change': { attached: string[] }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Host-only attached tool-group state; `null` means "never chosen". */
    toolGroups: ToolGroupsProjectionState
  }
}

/** Host fold state of the `toolGroups` unit. */
export interface ToolGroupsProjectionState {
  /** Attached group ids, or `null` before the session ever changed the set. */
  readonly attached: readonly string[] | null
}

const toolGroupsStateSchema: z.ZodType<ToolGroupsProjectionState> = z.object({
  attached: z.array(z.string().min(1)).nullable(),
})

/**
 * Fold one committed session event into the attached-set state.
 * @param state - the state covering all prior events.
 * @param event - the next committed session event.
 * @returns the next state (same reference when the event is not ours).
 */
export function applyToolGroupsProjection(
  state: ToolGroupsProjectionState,
  event: SessionEvent,
): ToolGroupsProjectionState {
  if (event.type !== 'tool-groups/change') return state
  return { attached: [...new Set(event.data.attached)] }
}

/** The `toolGroups` projection unit registered by the plugin. */
export const toolGroupsProjection: ProjectionDefinition<'toolGroups', ToolGroupsProjectionState> = {
  key: 'toolGroups',
  stateSchema: toolGroupsStateSchema,
  init: () => ({ attached: null }),
  apply: applyToolGroupsProjection,
  stateVersion: 1,
}
