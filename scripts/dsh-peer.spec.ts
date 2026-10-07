/**
 * dsh-peer settled-follow behavior (battery fix-36 scenario 2).
 *
 * After the first `turn/end` the CLI keeps following while the remote session
 * is not settled — a live descendant (a fan-out child), a pending ask, or a
 * follow-up turn inside the quiet window — and returns the FINAL turn's
 * assistant text, never the dispatch announcement. `--once` restores the
 * historical first-turn behavior.
 *
 * The peer client is stubbed at the frame level: the follow generator yields
 * scripted snapshot/state/event frames and parks until the follow controller
 * aborts, the same contract both real clients honor. The quiet window is
 * shrunk with `--settle-ms` so the spec does not sleep the 2s production
 * default.
 */

import { describe, expect, it } from 'vitest'

// @ts-expect-error The CLI is a plain runtime script with no declaration artifact.
import { DEFAULT_SETTLE_QUIET_MS, followToSettled, isPeerSessionSettled, parseArgs } from './dsh-peer.mjs'

interface ScriptedState {
  latch: string
  activeDescendants: number
  pendingAsks?: readonly unknown[]
  descendantsExact?: boolean
}

function ask(id: string): unknown {
  return { kind: 'approval', askId: id, toolName: 'bash', since: 1 }
}

function stateFrame(state: ScriptedState, cursor: number): unknown {
  return {
    type: 'state',
    cursor,
    state: { since: 0, source: 'host-latch', descendantsExact: true, pendingAsks: [], ...state },
  }
}

function eventFrame(seq: number, type: string, data: Record<string, unknown>): unknown {
  return { type: 'event', cursor: seq, record: { seq, time: 1, type, data } }
}

function assistantFrame(turn: number, text: string, seq: number): unknown {
  return eventFrame(seq, 'assistant/message', { turn, message: { content: [{ type: 'text', text }] } })
}

function turnEndFrame(turn: number, seq: number, reason = 'completed'): unknown {
  return eventFrame(seq, 'turn/end', { turn, reason: { kind: reason } })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** A frame-scripted peer client; after the script it parks until abort. */
function scriptedClient(
  steps: ReadonlyArray<{ delayMs?: number; frame: unknown }>,
): { follow(request: unknown, signal: AbortSignal): AsyncGenerator<unknown> } {
  return {
    async *follow(_request: unknown, signal: AbortSignal): AsyncGenerator<unknown> {
      for (const step of steps) {
        if (step.delayMs !== undefined) {
          await sleep(step.delayMs)
          if (signal.aborted) return
        }
        yield step.frame
      }
      await new Promise<void>((resolve) => {
        if (signal.aborted) { resolve(); return }
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    },
  }
}

function options(
  steps: ReadonlyArray<{ delayMs?: number; frame: unknown }>,
  flags: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    client: scriptedClient(steps),
    target: { kind: 'alias', alias: 'co-dev' },
    flags: { json: true, wait: 30, settleMs: 80, ...flags },
    requestId: 'peer-cli-spec',
    baselineTurn: 5,
    log: () => {},
  }
}

/** The fan-out timeline: dispatch turn, live children, settled summary turn. */
function fanOutTimeline(): ReadonlyArray<{ delayMs?: number; frame: unknown }> {
  return [
    { frame: stateFrame({ latch: 'running', activeDescendants: 0 }, 10) },
    { frame: assistantFrame(6, 'dispatch: two children still running', 12) },
    { frame: turnEndFrame(6, 13) },
    { frame: stateFrame({ latch: 'idle', activeDescendants: 2 }, 14) },
    { delayMs: 20, frame: eventFrame(15, 'turn/start', { turn: 7 }) },
    { frame: assistantFrame(7, 'FINAL SUMMARY: both children settled', 16) },
    { frame: turnEndFrame(7, 17) },
    { frame: stateFrame({ latch: 'idle', activeDescendants: 0 }, 18) },
  ]
}

describe('isPeerSessionSettled', () => {
  const terminal = { turn: 6, reason: 'completed' }

  it('requires a terminal and a quiet state', () => {
    expect(isPeerSessionSettled(undefined)).toBe(false)
    expect(isPeerSessionSettled({ terminal })).toBe(true)
    expect(isPeerSessionSettled({ terminal, latch: 'unknown', activeDescendants: 0, pendingAskCount: 0 })).toBe(true)
  })

  it('refuses while a turn, a child, an ask, or an inexact descendant count is live', () => {
    expect(isPeerSessionSettled({ terminal, latch: 'running', activeDescendants: 0, pendingAskCount: 0 })).toBe(false)
    expect(isPeerSessionSettled({ terminal, latch: 'idle', activeDescendants: 1, pendingAskCount: 0 })).toBe(false)
    expect(isPeerSessionSettled({ terminal, latch: 'waiting_approval', activeDescendants: 0, pendingAskCount: 1 })).toBe(false)
    expect(isPeerSessionSettled({ terminal, latch: 'idle', activeDescendants: 0, pendingAskCount: 0, descendantsExact: false })).toBe(false)
  })
})

describe('followToSettled', () => {
  it('follows past the dispatch turn/end to the settled summary (scenario 2)', async () => {
    const result = await followToSettled(options(fanOutTimeline()))
    expect(result.answer).toBe('FINAL SUMMARY: both children settled')
    expect(result.answer).not.toContain('dispatch')
    expect(result.settled).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.turn).toBe(7)
    expect(result.terminal).toBe('completed')
  })

  it('--once returns at the first turn/end with the dispatch answer', async () => {
    const result = await followToSettled(options(fanOutTimeline(), { once: true }))
    expect(result.answer).toBe('dispatch: two children still running')
    expect(result.settled).toBe(true)
    expect(result.turn).toBe(6)
  })

  it('keeps following while an ask is pending and returns the turn after it settles', async () => {
    const result = await followToSettled(options([
      { frame: stateFrame({ latch: 'running', activeDescendants: 0 }, 10) },
      { frame: assistantFrame(6, 'one question first', 12) },
      { frame: turnEndFrame(6, 13) },
      { frame: stateFrame({ latch: 'idle', activeDescendants: 0, pendingAsks: [ask('ask-1')] }, 14) },
      { delayMs: 20, frame: stateFrame({ latch: 'idle', activeDescendants: 0, pendingAsks: [] }, 15) },
      { frame: eventFrame(16, 'turn/start', { turn: 7 }) },
      { frame: assistantFrame(7, 'answered; final answer', 17) },
      { frame: turnEndFrame(7, 18) },
      { frame: stateFrame({ latch: 'idle', activeDescendants: 0 }, 19) },
    ]))
    expect(result.answer).toBe('answered; final answer')
    expect(result.asks).toEqual(['ask-1'])
    expect(result.turn).toBe(7)
  })

  it('reports the busy reason when the wait limit hits with children still live', async () => {
    const result = await followToSettled(options([
      { frame: stateFrame({ latch: 'running', activeDescendants: 0 }, 10) },
      { frame: assistantFrame(6, 'dispatch', 12) },
      { frame: turnEndFrame(6, 13) },
      { frame: stateFrame({ latch: 'idle', activeDescendants: 2 }, 14) },
    ], { wait: 0.05, settleMs: 5000 }))
    expect(result.pending).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.turn).toBe(6)
    expect(result.answer).toBe('dispatch')
    expect(result.note).toContain('2 live descendant(s)')
  })

  it('returns target-detached as pending, as before', async () => {
    const result = await followToSettled(options([
      { frame: stateFrame({ latch: 'running', activeDescendants: 0 }, 10) },
      { frame: assistantFrame(6, 'partial', 12) },
      { frame: turnEndFrame(6, 13) },
      { frame: { type: 'end', reason: 'target-detached' } },
    ]))
    expect(result.pending).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.note).toContain('target-detached')
  })

  it('folds assistant text per turn so a replayed old turn never re-appends', async () => {
    const result = await followToSettled(options([
      { frame: stateFrame({ latch: 'running', activeDescendants: 0 }, 10) },
      { frame: assistantFrame(6, 'draft one', 12) },
      { frame: assistantFrame(6, 'draft two', 13) },
      { frame: turnEndFrame(6, 14) },
      // A reconnect snapshot replays seq 12/13/14; dedupe must drop them.
      { frame: { type: 'snapshot', cursor: 14, state: { latch: 'idle', activeDescendants: 0, descendantsExact: true, pendingAsks: [] }, records: [
        { seq: 12, time: 1, type: 'assistant/message', data: { turn: 6, message: { content: [{ type: 'text', text: 'draft one' }] } } },
        { seq: 13, time: 1, type: 'assistant/message', data: { turn: 6, message: { content: [{ type: 'text', text: 'draft two' }] } } },
        { seq: 14, time: 1, type: 'turn/end', data: { turn: 6, reason: { kind: 'completed' } } },
      ] } },
    ]))
    expect(result.answer).toBe('draft one\ndraft two')
    expect(result.turn).toBe(6)
  })
})

describe('parseArgs', () => {
  it('parses --once and --settle-ms', () => {
    const parsed = parseArgs(['ask', 'co-dev', 'hello', '--once', '--settle-ms', '25'])
    expect(parsed.flags.once).toBe(true)
    expect(parsed.flags.settleMs).toBe(25)
    expect(parsed.positional).toEqual(['ask', 'co-dev', 'hello'])
  })

  it('defaults to settled following (no --once) and the shipped quiet window', () => {
    const parsed = parseArgs(['ask', 'co-dev', 'hello'])
    expect(parsed.flags.once).toBe(false)
    expect(parsed.flags.settleMs).toBeUndefined()
    expect(DEFAULT_SETTLE_QUIET_MS).toBeGreaterThan(0)
  })
})
