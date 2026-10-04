/**
 * Enpoi Harness Living Brief — the sessionProjections unit (doc 31 §2).
 *
 * Pure sync fold `(State, Event) => State`. No async, no I/O, no LLM inside.
 * Deterministic fields (phase, filesTouched, blockers) derive strictly from
 * native session events; prose fields (goal, decisions, openThreads) come
 * exclusively from `brief/prose-updated` events (I2 field ownership).
 * Goal precedence (I3): prose with `basedOnSeq < goalSeq` cannot touch goal.
 * Fold fail-safe (doc 35 §12.4): malformed events increment `foldErrors` and
 * are logged — the projection never crashes or corrupts.
 *
 * @module dsh-enpoi-living-brief
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import {
  livingBriefStateSchema,
  livingBriefViewSchema,
  type Blocker,
  type BriefEntry,
  type LivingBriefState,
  type LivingBriefView,
} from 'dsh-enpoi-contracts'

export const name = 'enpoi-living-brief'

/** The projection registry is optional — headless assemblies without it stay unaffected. */
export const inject = ['sessionProjections']

/** Edit tools whose `tool/call` arguments carry a `file_path` (filesTouched). */
const EDIT_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/** Structural event types — the only events that age the brief (Oracle amendment 4). */
const STRUCTURAL_TYPES = new Set(['user/message', 'turn/end', 'tool/call', 'tool/result'])

/** Bound the callId→name map so a long session cannot grow it unboundedly. */
const MAX_TOOL_NAMES = 200

/** Bound the prose entry lists so a long session cannot grow them unboundedly. */
const MAX_ENTRIES = 50

export function apply(ctx: Context): void {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register<'livingBrief', LivingBriefState>({
      key: 'livingBrief',
      stateSchema: livingBriefStateSchema,
      init: () => ({
        goal: '',
        decisions: [],
        constraints: [],
        openThreads: [],
        filesTouched: [],
        blockers: [],
        phase: 'idle',
        prose: null,
        goalSeq: 0,
        lastEventSeq: 0,
        foldErrors: 0,
        toolNames: {},
        structuralCount: 0,
      }),
      apply: (state, event) => fold(ctx, state, event),
      wire: {
        viewSchema: livingBriefViewSchema,
        view: (state) => view(state),
      },
      stateVersion: 1,
    })
  })
}

/** Pure transition — returns the SAME reference for events the unit ignores. */
export function fold(ctx: Context, state: LivingBriefState, event: SessionEvent): LivingBriefState {
  try {
    switch (event.type) {
      case 'turn/start':
        return { ...state, phase: 'working', lastEventSeq: event.seq }

      case 'turn/end': {
        const kind = (event.data as { reason: { kind: string } }).reason.kind
        return {
          ...state,
          phase: kind === 'aborted' ? 'aborted' : 'idle',
          lastEventSeq: event.seq,
          structuralCount: state.structuralCount + 1,
        }
      }

      case 'user/message':
        return { ...state, lastEventSeq: event.seq, structuralCount: state.structuralCount + 1 }

      case 'tool/call': {
        const data = event.data as { callId: string; name: string; arguments: string }
        const toolNames = { ...state.toolNames }
        toolNames[data.callId] = data.name
        // Bound the map (oldest entries dropped by insertion order).
        const keys = Object.keys(toolNames)
        if (keys.length > MAX_TOOL_NAMES) {
          for (const key of keys.slice(0, keys.length - MAX_TOOL_NAMES)) delete toolNames[key]
        }
        let filesTouched = state.filesTouched
        if (EDIT_TOOLS.has(data.name)) {
          const path = extractFilePath(data.arguments)
          if (path !== undefined && !filesTouched.includes(path)) {
            filesTouched = [...filesTouched, path]
          }
        }
        return {
          ...state,
          toolNames,
          filesTouched,
          lastEventSeq: event.seq,
          structuralCount: state.structuralCount + 1,
        }
      }

      case 'tool/result': {
        const data = event.data as {
          callId?: string
          message?: { source?: { callId?: string } }
          error?: { name: string; code: string }
        }
        if (data.error === undefined) {
          return { ...state, lastEventSeq: event.seq, structuralCount: state.structuralCount + 1 }
        }
        // A result carries its call id on the message source, not on the event
        // data; the old read made every blocker's `tool` undefined.
        const callId = data.callId ?? data.message?.source?.callId
        const tool = callId === undefined ? undefined : state.toolNames[callId]
        const blocker: Blocker = {
          id: `b-${event.seq}`,
          text: `${data.error.name}: ${data.error.code}`,
          ...(tool === undefined ? {} : { tool }),
          seq: event.seq,
        }
        return {
          ...state,
          blockers: [...state.blockers, blocker].slice(-MAX_ENTRIES),
          lastEventSeq: event.seq,
          structuralCount: state.structuralCount + 1,
        }
      }

      case 'brief/prose-updated': {
        const data = event.data as {
          goal?: string
          decisions?: string[]
          openThreads?: string[]
          basedOnSeq: number
          /** Absent on keeper events written before the structural watermark existed. */
          basedOnStructuralCount?: number
          structuralDistanceK?: number
          model: string
          text: string
          origin: string
        }
        // I2: only the keeper may write prose fields.
        if (data.origin !== 'context-keeper') return { ...state, lastEventSeq: event.seq }
        const next: LivingBriefState = {
          ...state,
          prose: {
            text: data.text,
            updatedAt: event.time,
            model: data.model,
            basedOnSeq: data.basedOnSeq,
            // Legacy keeper events predate the structural watermark; 0 keeps
            // the prose honestly stale until the next keeper update.
            basedOnStructuralCount: data.basedOnStructuralCount ?? 0,
            structuralDistanceK: data.structuralDistanceK ?? 24,
          },
          lastEventSeq: event.seq,
        }
        // I3: goal precedence — prose based on a seq before the last steered
        // goal cannot touch the goal.
        if (data.goal !== undefined && data.basedOnSeq >= state.goalSeq) {
          next.goal = data.goal
        }
        if (data.decisions !== undefined) {
          next.decisions = entries(data.decisions, event.seq)
        }
        if (data.openThreads !== undefined) {
          next.openThreads = entries(data.openThreads, event.seq)
        }
        return next
      }

      default:
        // Uninterested — same reference, zero downstream work.
        return state
    }
  } catch (error) {
    ctx.logger.warn(`enpoi-living-brief: fold anomaly on ${event.type} seq ${event.seq}: ${String(error)}`)
    return { ...state, foldErrors: state.foldErrors + 1, lastEventSeq: event.seq }
  }
}

/** Map prose strings to brief entries with stable ids. */
function entries(texts: string[], seq: number): BriefEntry[] {
  return texts.slice(-MAX_ENTRIES).map((text, i) => ({ id: `e-${seq}-${i}`, text, seq }))
}

/** Extract `file_path` from a tool-call arguments JSON string (best effort). */
function extractFilePath(argumentsJson: string): string | undefined {
  try {
    const parsed = JSON.parse(argumentsJson) as { file_path?: unknown }
    return typeof parsed.file_path === 'string' && parsed.file_path.length > 0
      ? parsed.file_path
      : undefined
  } catch {
    return undefined
  }
}

/** State → wire payload. Freshness is STRUCTURAL-SEQ distance (Oracle amendment 4) — wall-clock age is display-only. */
export function view(state: LivingBriefState): LivingBriefView {
  const freshness: LivingBriefView['freshness'] = state.prose === null
    ? 'stale'
    : state.structuralCount - state.prose.basedOnStructuralCount <= state.prose.structuralDistanceK
      ? 'live'
      : state.structuralCount - state.prose.basedOnStructuralCount <= state.prose.structuralDistanceK * 2
        ? 'cooling'
        : 'stale'
  return {
    goal: state.goal,
    decisions: state.decisions,
    constraints: state.constraints,
    openThreads: state.openThreads,
    filesTouched: state.filesTouched,
    blockers: state.blockers,
    phase: state.phase,
    prose: state.prose,
    asOfSeq: state.lastEventSeq,
    freshness,
  }
}