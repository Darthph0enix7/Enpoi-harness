/**
 * Compaction-history fold: counts committed summarizing compactions and keeps
 * the newest shadow span, with the in-flight lifecycle held between
 * `compaction/start` and `compaction/end`.
 *
 * @module @deepseek-ai/dsh-token-meter/compaction-projection
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ContextCompactionsProjection } from './projection.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    contextCompactions: ContextCompactionsState
  }
}

const count = z.number().int().nonnegative()

/** Wire value schema; `last` is absent until a compaction commits. */
const compactionViewSchema: z.ZodType<ContextCompactionsProjection> = z.object({
  count,
  mechanicalCount: count,
  failedCount: count,
  last: z.object({
    endSeq: count,
    at: count,
    shadowedNodes: count,
    shadowedTokens: count,
    manual: z.boolean(),
    mechanical: z.boolean(),
  }).strict().optional(),
}).strict().transform(({ count: commits, mechanicalCount, failedCount, last }) => ({
  count: commits,
  mechanicalCount,
  failedCount,
  ...last === undefined ? {} : { last },
}))

/**
 * Facts gathered between `compaction/start` and `compaction/end`; the end
 * event carries no summary facts of its own, so they are held here.
 */
const openCompactionSchema = z.object({
  compactionId: z.string(),
  manual: z.boolean(),
  summarized: z.boolean(),
  mechanical: z.boolean(),
  shadowedNodes: count,
  shadowedTokens: count,
}).strict()

type OpenCompaction = z.infer<typeof openCompactionSchema>

/**
 * The installed view travels inside the state so an internal-only change (an
 * open lifecycle) keeps the identical wire reference and publishes nothing.
 */
const contextCompactionsStateSchema = z.object({
  view: compactionViewSchema,
  open: openCompactionSchema.nullable(),
}).strict()

type ContextCompactionsState = z.infer<typeof contextCompactionsStateSchema>

/** A fresh zero view; one instance per session state so no two folds share it. */
function zeroView(): ContextCompactionsProjection {
  return { count: 0, mechanicalCount: 0, failedCount: 0 }
}

/**
 * Draft for a summary whose `compaction/start` is missing from the fold
 * window; a legal log always starts one first, but the fold stays total.
 */
function draftFrom(event: SessionEvent<'compaction/summary'>): OpenCompaction {
  return {
    compactionId: event.data.compactionId,
    manual: event.data.sourceCommandId !== undefined,
    summarized: true,
    mechanical: event.data.provider === '',
    shadowedNodes: event.data.shadowedSeqs.length,
    shadowedTokens: event.data.shadowedTokenCount,
  }
}

/**
 * Committed summarizing compactions. An error-free end with a summary under
 * the same compaction id is the only commit point: it increments `count`
 * (and `mechanicalCount` for a `provider === ''` stub) and replaces `last`.
 * An end carrying `error` increments `failedCount` only. The open lifecycle
 * changes state without changing the view reference.
 */
export const contextCompactionsProjectionDefinition = {
  key: 'contextCompactions',
  stateVersion: 1,
  stateSchema: contextCompactionsStateSchema,
  init: (): ContextCompactionsState => ({ view: zeroView(), open: null }),
  apply: (state, event) => {
    switch (event.type) {
      case 'compaction/start':
        return {
          view: state.view,
          open: {
            compactionId: event.data.compactionId,
            manual: event.data.sourceCommandId !== undefined,
            summarized: false,
            mechanical: false,
            shadowedNodes: 0,
            shadowedTokens: 0,
          },
        }
      case 'compaction/summary':
        return {
          view: state.view,
          open: state.open?.compactionId === event.data.compactionId
            ? {
              ...state.open,
              manual: state.open.manual || event.data.sourceCommandId !== undefined,
              summarized: true,
              mechanical: event.data.provider === '',
              shadowedNodes: event.data.shadowedSeqs.length,
              shadowedTokens: event.data.shadowedTokenCount,
            }
            : draftFrom(event),
        }
      case 'compaction/end': {
        const open = state.open?.compactionId === event.data.compactionId ? state.open : undefined
        if (event.data.error !== undefined) {
          return {
            view: { ...state.view, failedCount: state.view.failedCount + 1 },
            open: null,
          }
        }
        if (open?.summarized !== true) {
          // Nothing was committed and nothing failed; drop the stale draft.
          return state.open === null ? state : { view: state.view, open: null }
        }
        return {
          view: {
            count: state.view.count + 1,
            mechanicalCount: state.view.mechanicalCount + (open.mechanical ? 1 : 0),
            failedCount: state.view.failedCount,
            last: {
              endSeq: event.seq,
              at: event.time,
              shadowedNodes: open.shadowedNodes,
              shadowedTokens: open.shadowedTokens,
              manual: open.manual,
              mechanical: open.mechanical,
            },
          },
          open: null,
        }
      }
      default:
        return state
    }
  },
  wire: {
    viewSchema: compactionViewSchema,
    view: state => state.view,
  },
} satisfies ProjectionDefinition<'contextCompactions', ContextCompactionsState>
