/**
 * dsh-peer settled-follow behavior (battery fix-36 scenario 2) plus the caller
 * reliability contract: admission-attributed turns, seq deduplication across
 * reconnect snapshots, requestId retry persistence after a post-admission
 * transport failure, caller-terminal stream errors, durable-repair hole
 * warnings, and post-commit confirmation reads for one-shot `answer`/`cancel`.
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

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  ASK_RETRY_TTL_MS, CALLER_HARNESS_VERSION_ENV, DEFAULT_SETTLE_QUIET_MS, LocalPeerClient, askStatePath, beginAsk,
  commandAnswer, commandAsk, commandCancel, commandModels, commandSwitch, createRoutingFlags, finishAsk, followToSettled,
  isPeerSessionSettled, parseArgs, parseModelRoute, resolveCallerHarnessVersion,
// @ts-expect-error The CLI is a plain runtime script with no declaration artifact.
} from './dsh-peer.mjs'

interface ScriptedState {
  latch: string
  activeDescendants: number
  pendingAsks?: readonly unknown[]
  descendantsExact?: boolean
}

interface ScriptedStep {
  delayMs?: number
  frame: unknown
}

interface ScriptedStateValue {
  cursor: number
  state: ScriptedState & Record<string, unknown>
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

function turnStartFrame(turn: number, seq: number): unknown {
  return eventFrame(seq, 'turn/start', { turn })
}

function userFrame(rpcId: string, seq: number): unknown {
  return eventFrame(seq, 'user/message', { source: { kind: 'user', rpcId }, content: [{ type: 'text', text: 'hello' }] })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** A frame-scripted peer client; after the script it parks until abort. */
function scriptedClient(
  steps: ReadonlyArray<ScriptedStep>,
  stateValues: ReadonlyArray<ScriptedStateValue> = [],
): Record<string, unknown> {
  const client: Record<string, unknown> = {
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
  if (stateValues.length > 0) {
    let index = 0
    client.state = async () => {
      const value = stateValues[Math.min(index, stateValues.length - 1)]!
      index += 1
      return value
    }
  }
  return client
}

function options(
  steps: ReadonlyArray<ScriptedStep>,
  flags: Record<string, unknown> = {},
  stateValues: ReadonlyArray<ScriptedStateValue> = [],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    client: scriptedClient(steps, stateValues),
    target: { kind: 'alias', alias: 'co-dev' },
    flags: { json: true, wait: 30, settleMs: 80, ...flags },
    requestId: 'peer-cli-spec',
    baselineTurn: 5,
    log: () => {},
    ...extra,
  }
}

/** The fan-out timeline: dispatch turn, live children, settled summary turn. */
function fanOutTimeline(): ReadonlyArray<ScriptedStep> {
  return [
    { frame: stateFrame({ latch: 'running', activeDescendants: 0 }, 10) },
    { frame: turnStartFrame(6, 11) },
    { frame: userFrame('peer-cli-spec', 12) },
    { frame: assistantFrame(6, 'dispatch: two children still running', 13) },
    { frame: turnEndFrame(6, 14) },
    { frame: stateFrame({ latch: 'idle', activeDescendants: 2 }, 15) },
    { delayMs: 20, frame: turnStartFrame(7, 16) },
    { frame: assistantFrame(7, 'FINAL SUMMARY: both children settled', 17) },
    { frame: turnEndFrame(7, 18) },
    { frame: stateFrame({ latch: 'idle', activeDescendants: 0 }, 19) },
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
      { frame: turnStartFrame(6, 11) },
      { frame: userFrame('peer-cli-spec', 12) },
      { frame: assistantFrame(6, 'one question first', 13) },
      { frame: turnEndFrame(6, 14) },
      { frame: stateFrame({ latch: 'idle', activeDescendants: 0, pendingAsks: [ask('ask-1')] }, 15) },
      { delayMs: 20, frame: stateFrame({ latch: 'idle', activeDescendants: 0, pendingAsks: [] }, 16) },
      { frame: turnStartFrame(7, 17) },
      { frame: assistantFrame(7, 'answered; final answer', 18) },
      { frame: turnEndFrame(7, 19) },
      { frame: stateFrame({ latch: 'idle', activeDescendants: 0 }, 20) },
    ]))
    expect(result.answer).toBe('answered; final answer')
    expect(result.asks).toEqual(['ask-1'])
    expect(result.turn).toBe(7)
  })

  it('reports the busy reason when the wait limit hits with children still live', async () => {
    const result = await followToSettled(options([
      { frame: stateFrame({ latch: 'running', activeDescendants: 0 }, 10) },
      { frame: turnStartFrame(6, 11) },
      { frame: userFrame('peer-cli-spec', 12) },
      { frame: assistantFrame(6, 'dispatch', 13) },
      { frame: turnEndFrame(6, 14) },
      { frame: stateFrame({ latch: 'idle', activeDescendants: 2 }, 15) },
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
      { frame: turnStartFrame(6, 11) },
      { frame: userFrame('peer-cli-spec', 12) },
      { frame: assistantFrame(6, 'partial', 13) },
      { frame: turnEndFrame(6, 14) },
      { frame: { type: 'end', reason: 'target-detached' } },
    ]))
    expect(result.pending).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.note).toContain('target-detached')
  })

  it('folds assistant text per turn so a replayed old turn never re-appends', async () => {
    const result = await followToSettled(options([
      { frame: stateFrame({ latch: 'running', activeDescendants: 0 }, 10) },
      { frame: turnStartFrame(6, 11) },
      { frame: userFrame('peer-cli-spec', 12) },
      { frame: assistantFrame(6, 'draft one', 13) },
      { frame: assistantFrame(6, 'draft two', 14) },
      { frame: turnEndFrame(6, 15) },
      // A reconnect snapshot replays seq 12/13/14/15; dedupe must drop them.
      { frame: { type: 'snapshot', cursor: 15, state: { latch: 'idle', activeDescendants: 0, descendantsExact: true, pendingAsks: [] }, records: [
        { seq: 12, time: 1, type: 'user/message', data: { source: { kind: 'user', rpcId: 'peer-cli-spec' }, content: [{ type: 'text', text: 'hello' }] } },
        { seq: 13, time: 1, type: 'assistant/message', data: { turn: 6, message: { content: [{ type: 'text', text: 'draft one' }] } } },
        { seq: 14, time: 1, type: 'assistant/message', data: { turn: 6, message: { content: [{ type: 'text', text: 'draft two' }] } } },
        { seq: 15, time: 1, type: 'turn/end', data: { turn: 6, reason: { kind: 'completed' } } },
      ] } },
    ]))
    expect(result.answer).toBe('draft one\ndraft two')
    expect(result.turn).toBe(6)
  })

  it('ignores a third-party turn that ended before our prompt was admitted', async () => {
    const result = await followToSettled(options([
      { frame: stateFrame({ latch: 'running', activeDescendants: 0 }, 10) },
      { frame: assistantFrame(6, 'third-party noise', 11) },
      { frame: turnEndFrame(6, 12) },
    ], { wait: 0.05, settleMs: 5000 }))
    expect(result.pending).toBe(true)
    expect(result.admitted).toBe(false)
    expect(result.answer).toBe('')
    expect(result.turn).toBeUndefined()
  })

  it('reports a host-accepted prompt as admitted before its turn starts', async () => {
    const result = await followToSettled(options([
      { frame: stateFrame({ latch: 'running', activeDescendants: 0 }, 10) },
      { frame: assistantFrame(6, 'third-party noise', 11) },
      { frame: turnEndFrame(6, 12) },
    ], { wait: 0.05, settleMs: 5000 }, [], { promptAccepted: true }))
    expect(result.pending).toBe(true)
    expect(result.admitted).toBe(true)
    expect(result.answer).toBe('')
    expect(result.turn).toBeUndefined()
  })

  it("keeps our turn's answer when a different operator's prompt opens a later turn", async () => {
    const result = await followToSettled(options([
      { frame: stateFrame({ latch: 'running', activeDescendants: 0 }, 10) },
      { frame: turnStartFrame(6, 11) },
      { frame: userFrame('peer-cli-spec', 12) },
      { frame: assistantFrame(6, 'our answer', 13) },
      { frame: turnEndFrame(6, 14) },
      { frame: stateFrame({ latch: 'running', activeDescendants: 0 }, 15) },
      { delayMs: 10, frame: turnStartFrame(7, 16) },
      { frame: userFrame('peer-cli-other', 17) },
      { frame: assistantFrame(7, 'their answer', 18) },
      { frame: turnEndFrame(7, 19) },
      { frame: stateFrame({ latch: 'idle', activeDescendants: 0 }, 20) },
    ], { settleMs: 5000 }))
    expect(result.answer).toBe('our answer')
    expect(result.turn).toBe(6)
    expect(result.terminal).toBe('completed')
    expect(result.ok).toBe(true)
    expect(result.settled).toBe(true)
    expect(result.superseded).toBe(true)
  })

  it("does not report an earlier turn's answer under a later turn's terminal", async () => {
    const result = await followToSettled(options([
      { frame: stateFrame({ latch: 'running', activeDescendants: 0 }, 10) },
      { frame: turnStartFrame(6, 11) },
      { frame: userFrame('peer-cli-spec', 12) },
      { frame: assistantFrame(6, 'our answer', 13) },
      { frame: turnEndFrame(6, 14) },
      { frame: stateFrame({ latch: 'running', activeDescendants: 0 }, 15) },
      { delayMs: 10, frame: turnStartFrame(7, 16) },
      { frame: turnEndFrame(7, 17, 'error') },
      { frame: stateFrame({ latch: 'idle', activeDescendants: 0 }, 18) },
    ]))
    expect(result.turn).toBe(7)
    expect(result.terminal).toBe('error')
    expect(result.answer).toBe('')
    expect(result.ok).toBe(false)
  })

  it('keeps the answer committed by a turn that ended in error', async () => {
    const result = await followToSettled(options([
      { frame: stateFrame({ latch: 'running', activeDescendants: 0 }, 10) },
      { frame: turnStartFrame(6, 11) },
      { frame: userFrame('peer-cli-spec', 12) },
      { frame: assistantFrame(6, 'work done then upstream died', 13) },
      { frame: turnEndFrame(6, 14, 'error') },
      { frame: stateFrame({ latch: 'idle', activeDescendants: 0 }, 15) },
    ]))
    expect(result.turn).toBe(6)
    expect(result.terminal).toBe('error')
    expect(result.answer).toBe('work done then upstream died')
    expect(result.ok).toBe(false)
  })

  it('confirms a settled quiet window against a fresh state read', async () => {
    const result = await followToSettled(options([
      { frame: stateFrame({ latch: 'running', activeDescendants: 0 }, 10) },
      { frame: turnStartFrame(6, 11) },
      { frame: userFrame('peer-cli-spec', 12) },
      { frame: assistantFrame(6, 'draft', 13) },
      { frame: turnEndFrame(6, 14) },
      { frame: stateFrame({ latch: 'idle', activeDescendants: 0 }, 15) },
    ], {}, [
      // The quiet aborts the stream; the confirming read finds a new child.
      { cursor: 16, state: { latch: 'running', activeDescendants: 1, descendantsExact: true, pendingAsks: [] } },
    ]))
    expect(result.pending).toBe(true)
    expect(result.settled).toBe(false)
    expect(result.turn).toBe(6)
    expect(result.note).toContain('live descendant')
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

// ── Ask retry persistence ────────────────────────────────────────────────────

const PAIRING_DOC = [
  'version: 1',
  'device: caller',
  'pairings:',
  '  - alias: co-dev',
  '    peer: serverlocal',
  '    exposure: debug',
  '    endpoint: https://peer.test:8443',
  '',
].join('\n')

function pairingFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-peer-ask-'))
  const path = join(dir, 'pairings.yaml')
  writeFileSync(path, PAIRING_DOC)
  return path
}

function commandArgs(argv: string[], pairingsPath: string): { flags: Record<string, unknown>; positional: string[] } {
  return parseArgs([...argv, '--pairings', pairingsPath, '--wait', '5', '--settle-ms', '20'])
}

describe('beginAsk / finishAsk', () => {
  it('reuses a fresh same-target entry and refuses a different target or message', () => {
    const path = askStatePath(pairingFile())
    const first = beginAsk({ statePath: path, alias: 'co-dev', target: 'sess-a', message: 'same', baselineTurn: 3, now: 1_000 })
    const retry = beginAsk({ statePath: path, alias: 'co-dev', target: 'sess-a', message: 'same', baselineTurn: 99, now: 1_000 + ASK_RETRY_TTL_MS - 1 })
    expect(retry).toMatchObject({ requestId: first.requestId, reused: true, baselineTurn: 3 })
    const otherTarget = beginAsk({ statePath: path, alias: 'co-dev', target: 'sess-b', message: 'same', baselineTurn: 9, now: 1_000 })
    expect(otherTarget.reused).toBe(false)
    expect(otherTarget.requestId).not.toBe(first.requestId)
    const different = beginAsk({ statePath: path, alias: 'co-dev', target: 'sess-a', message: 'other', baselineTurn: 9, now: 1_000 })
    expect(different.reused).toBe(false)
    expect(different.requestId).not.toBe(first.requestId)
  })

  it('ignores an entry older than the retry TTL and clears on finish', () => {
    const path = askStatePath(pairingFile())
    const first = beginAsk({ statePath: path, alias: 'co-dev', target: 'sess-a', message: 'same', baselineTurn: 3, now: 1_000 })
    const stale = beginAsk({ statePath: path, alias: 'co-dev', target: 'sess-a', message: 'same', baselineTurn: 9, now: 1_000 + ASK_RETRY_TTL_MS + 1 })
    expect(stale.reused).toBe(false)
    expect(stale.requestId).not.toBe(first.requestId)
    finishAsk(path, 'co-dev', stale.requestId)
    const afterFinish = beginAsk({ statePath: path, alias: 'co-dev', target: 'sess-a', message: 'same', baselineTurn: 9, now: 1_000 + ASK_RETRY_TTL_MS + 2 })
    expect(afterFinish.reused).toBe(false)
  })
})

function askHarness(): {
  state: { admitted: string[]; currentRequestId: string | undefined; failNextPrompt: boolean }
  client: Record<string, unknown>
} {
  const state = {
    admitted: [] as string[],
    currentRequestId: undefined as string | undefined,
    failNextPrompt: true,
  }
  const baseline = {
    target: { device: 'serverlocal', sessionId: 'sess-1', exposure: 'debug', alias: 'co-dev' },
    state: {
      latch: 'idle', since: 0, source: 'host-latch', activeDescendants: 0, descendantsExact: true,
      pendingAsks: [] as unknown[], lastTurnEnd: { turn: 0, reason: 'completed', at: 0 },
    },
    cursor: 8,
  }
  const client: Record<string, unknown> = {
    handshake: async () => ({ protocolVersion: 1, harnessVersion: '0.1.6-alpha.2', schemaDigest: '', hostDevice: 'serverlocal', capabilities: [], pairings: [] }),
    state: async () => baseline,
    prompt: async (request: { requestId: string }) => {
      state.currentRequestId = request.requestId
      if (!state.admitted.includes(request.requestId)) state.admitted.push(request.requestId)
      if (state.failNextPrompt) {
        state.failNextPrompt = false
        throw new Error('socket hang up after admission')
      }
      return { accepted: true, queued: true, hopCount: 1 }
    },
    follow: async function* (): AsyncGenerator<unknown> {
      const id = state.currentRequestId
      yield {
        type: 'snapshot',
        cursor: 12,
        state: { latch: 'idle', since: 0, source: 'host-latch', activeDescendants: 0, descendantsExact: true, pendingAsks: [] },
        records: [
          { seq: 9, time: 1, type: 'turn/start', data: { turn: 1 } },
          { seq: 10, time: 1, type: 'user/message', data: { source: { kind: 'user', rpcId: id }, content: [{ type: 'text', text: 'hello' }] } },
          { seq: 11, time: 1, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'the answer' }] } } },
          { seq: 12, time: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
        ],
      }
    },
  }
  return { state, client }
}

describe('commandAsk requestId persistence', () => {
  it('reuses the admitted requestId after a post-admission transport failure', async () => {
    const pairingsPath = pairingFile()
    const { flags, positional } = commandArgs(['ask', 'co-dev', 'hello'], pairingsPath)
    const harness = askHarness()
    let clientOptions: Record<string, unknown> | undefined
    const deps = { clientFactory: (options: Record<string, unknown>) => { clientOptions = options; return harness.client } }
    await expect(commandAsk(flags, positional, deps)).rejects.toThrowError('socket hang up after admission')
    expect(harness.state.admitted).toHaveLength(1)
    // `ask` follows until --wait expires: unbounded reconnects, like `follow`.
    expect(clientOptions?.maxReconnects).toBeUndefined()
    expect(typeof clientOptions?.onWarning).toBe('function')
    const firstRequestId = harness.state.admitted[0]!

    const retry = await commandAsk(flags, positional, deps) as Record<string, unknown>
    expect(retry).toMatchObject({ ok: true, requestReused: true, answer: 'the answer', turn: 1 })
    expect(retry.requestId).toBe(firstRequestId)
    // The host dedups a repeated requestId: one user message, not two.
    expect(harness.state.admitted).toHaveLength(1)

    const fresh = await commandAsk(flags, positional, deps) as Record<string, unknown>
    expect(fresh.requestId).not.toBe(firstRequestId)
    expect(fresh.requestReused).toBe(false)
    expect(harness.state.admitted).toHaveLength(2)
  })

  it('never leaks a requestId into an unrelated alias', async () => {
    const pairingsPath = pairingFile()
    const { flags, positional } = commandArgs(['ask', 'co-dev', 'hello'], pairingsPath)
    const harness = askHarness()
    const deps = { clientFactory: () => harness.client }
    const first = beginAsk({ statePath: askStatePath(pairingsPath), alias: 'other', message: 'hello', baselineTurn: 0, now: 1 })
    await expect(commandAsk(flags, positional, deps)).rejects.toThrowError('socket hang up after admission')
    expect(harness.state.admitted[0]).not.toBe(first.requestId)
  })

  it('reports a recorded prompt as admitted even when no turn of ours has started', async () => {
    const pairingsPath = pairingFile()
    const { flags, positional } = commandArgs(['ask', 'co-dev', 'hello'], pairingsPath)
    const baseline = {
      target: { device: 'serverlocal', sessionId: 'sess-1', exposure: 'debug', alias: 'co-dev' },
      state: {
        latch: 'running', since: 0, source: 'host-latch', activeDescendants: 0, descendantsExact: true,
        pendingAsks: [] as unknown[], lastTurnEnd: { turn: 0, reason: 'completed', at: 0 },
      },
      cursor: 8,
    }
    const client = {
      handshake: async () => ({ protocolVersion: 1, harnessVersion: '0.1.6-alpha.2', schemaDigest: '', hostDevice: 'serverlocal', capabilities: [], pairings: [] }),
      state: async () => baseline,
      prompt: async () => ({ accepted: true, queued: true, hopCount: 1 }),
      follow: async function* (): AsyncGenerator<unknown> {
        // Another operator's turn runs while our accepted prompt waits in the
        // queue; its terminal and answer are not ours.
        yield {
          type: 'snapshot',
          cursor: 12,
          state: { latch: 'running', since: 0, source: 'host-latch', activeDescendants: 0, descendantsExact: true, pendingAsks: [] },
          records: [
            { seq: 9, time: 1, type: 'turn/start', data: { turn: 1 } },
            { seq: 10, time: 1, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'another operator answer' }] } } },
            { seq: 11, time: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } },
          ],
        }
      },
    }
    const result = await commandAsk(flags, positional, { clientFactory: () => client }) as Record<string, unknown>
    expect(result).toMatchObject({ admitted: true, pending: true, ok: false })
    expect(result.terminal).toBeUndefined()
    expect(result.answer).toBe('')
    expect(String(result.note)).toContain('without a terminal')
  })
})

// ── One-shot RPC post-commit confirmation ────────────────────────────────────

function transportFailure(message = 'socket closed'): Error {
  const error = new Error(message)
  ;(error as Error & { code?: string }).code = 'peer/target-unreachable'
  return error
}

describe('commandAnswer confirmation', () => {
  it('reports settled-remotely when the answer transport fails but the ask is gone', async () => {
    const pairingsPath = pairingFile()
    const { flags, positional } = commandArgs(['answer', 'co-dev', 'ask-1', 'once'], pairingsPath)
    let pending = [{ askId: 'ask-1', kind: 'approval', toolName: 'bash', since: 1 }]
    const client = {
      state: async () => ({
        target: { device: 'serverlocal', sessionId: 'sess-1', exposure: 'debug', alias: 'co-dev' },
        state: { latch: 'idle', since: 0, source: 'host-latch', activeDescendants: 0, descendantsExact: true, pendingAsks: pending },
        cursor: 5,
      }),
      answer: async (request: { askId: string }) => {
        // The remote applied the answer, then the response was lost.
        pending = pending.filter(item => item.askId !== request.askId)
        throw transportFailure()
      },
    }
    const result = await commandAnswer(flags, positional, { clientFactory: () => client }) as Record<string, unknown>
    expect(result).toMatchObject({ ok: true, settled: false, confirmation: 'lost' })
    expect(String(result.note)).toContain('no longer pending')
  })

  it('keeps the transport failure when a confirming read still shows the ask', async () => {
    const pairingsPath = pairingFile()
    const { flags, positional } = commandArgs(['answer', 'co-dev', 'ask-1', 'once'], pairingsPath)
    const client = {
      state: async () => ({
        target: { device: 'serverlocal', sessionId: 'sess-1', exposure: 'debug', alias: 'co-dev' },
        state: { latch: 'waiting_approval', since: 0, source: 'host-latch', activeDescendants: 0, descendantsExact: true, pendingAsks: [{ askId: 'ask-1', kind: 'approval', since: 1 }] },
        cursor: 5,
      }),
      answer: async () => { throw transportFailure() },
    }
    await expect(commandAnswer(flags, positional, { clientFactory: () => client })).rejects.toThrowError('socket closed')
  })

  it('reports lost confirmation for a cancel when the remote shows no active turn', async () => {
    const pairingsPath = pairingFile()
    const { flags, positional } = commandArgs(['cancel', 'co-dev'], pairingsPath)
    const client = {
      cancel: async () => { throw transportFailure() },
      state: async () => ({
        target: { device: 'serverlocal', sessionId: 'sess-1', exposure: 'debug', alias: 'co-dev' },
        state: { latch: 'idle', since: 0, source: 'host-latch', activeDescendants: 0, descendantsExact: true, pendingAsks: [] },
        cursor: 5,
      }),
    }
    const result = await commandCancel(flags, positional, { clientFactory: () => client }) as Record<string, unknown>
    expect(result).toMatchObject({ ok: true, cancelled: false, confirmation: 'lost' })
    expect(String(result.note)).toContain('no active turn')
  })
})

// ── LocalPeerClient stream and repair behavior ───────────────────────────────

class ScriptedSocket {
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  constructor(private readonly onSend: (socket: ScriptedSocket, streamId: string) => void) {}

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
    if (type === 'open') queueMicrotask(() => { this.emit('open', {}) })
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  send(data: string): void {
    const parsed = JSON.parse(data) as { type: string; streamId: string }
    if (parsed.type === 'open') this.onSend(this, parsed.streamId)
  }

  close(): void {
    this.emit('close', {})
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

function okResponse(value: unknown): Response {
  return new Response(JSON.stringify({ type: 'server-response', rpcId: 'x', result: { ok: true, value } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('LocalPeerClient reliability', () => {
  it('breaks a follow on caller-terminal peer error frames', async () => {
    for (const code of ['peer/not-paired', 'peer/not-found', 'peer/forbidden']) {
      let generations = 0
      const client = new LocalPeerClient({
        endpoint: 'https://peer.test:8443',
        device: 'caller',
        fetch: (async () => okResponse({})) as unknown as typeof fetch,
        backoff: { initialMs: 1, maxMs: 2, factor: 2 },
        webSocket: () => {
          generations += 1
          return new ScriptedSocket((socket, streamId) => {
            socket.emit('message', { data: JSON.stringify({ streamId, type: 'error', value: { code, message: 'terminal' } }) })
          })
        },
      })
      const controller = new AbortController()
      await expect((async () => {
        for await (const _frame of client.follow({ target: { kind: 'alias', alias: 'x' } }, controller.signal)) {
          // drain
        }
      })()).rejects.toMatchObject({ code })
      expect(generations).toBe(1)
    }
  })

  it('warns with the missing range when a repair cannot prove contiguity', async () => {
    const warnings: Array<{ from: number; to: number }> = []
    const client = new LocalPeerClient({
      endpoint: 'https://peer.test:8443',
      device: 'caller',
      fetch: (async () => okResponse({
        // throughSeq 7: the page bottoms out at 7, so seq 6 is missing.
        records: [{ seq: 7, time: 1, type: 'assistant/message', data: {} }],
        hasMore: false,
      })) as unknown as typeof fetch,
      onWarning: (hole: { from: number; to: number }) => { warnings.push(hole) },
    })
    const frames: Array<{ record: { seq: number } }> = []
    for await (const frame of client.repairForward({ kind: 'alias', alias: 'x' }, 5, 8, new AbortController().signal)) {
      frames.push(frame as { record: { seq: number } })
    }
    expect(warnings).toEqual([{ from: 6, to: 7 }])
    expect(frames.map(frame => frame.record.seq)).toEqual([7])
  })
})

// ── Caller identity and model-control parity ────────────────────────────────

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('caller harness version', () => {
  it('prefers the explicit option, then the env override', () => {
    const saved = process.env[CALLER_HARNESS_VERSION_ENV]
    try {
      process.env[CALLER_HARNESS_VERSION_ENV] = '9.9.9-env'
      expect(resolveCallerHarnessVersion({ harnessVersion: '9.9.9-option' })).toBe('9.9.9-option')
      expect(resolveCallerHarnessVersion()).toBe('9.9.9-env')
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, CALLER_HARNESS_VERSION_ENV)
      else process.env[CALLER_HARNESS_VERSION_ENV] = saved
    }
  })

  it('reads the installed identity `dsh --version` reports, then the tree manifest', () => {
    const home = tmpDir('dsh-peer-version-')
    mkdirSync(join(home, 'harness'), { recursive: true })
    writeFileSync(join(home, 'harness', 'install-state.json'), JSON.stringify({ version: '9.9.9-installed' }))
    expect(resolveCallerHarnessVersion({ dshHome: home, profileRoot: home })).toBe('9.9.9-installed')
    // Absent install state falls through to the source tree's root manifest.
    const rootManifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(resolveCallerHarnessVersion({ dshHome: tmpDir('dsh-peer-version-none-'), profileRoot: tmpDir('dsh-peer-profile-none-') })).toBe(rootManifest.version)
  })

  it('falls back to the profile peer manifest, and skips a malformed one', () => {
    const home = tmpDir('dsh-peer-profile-home-')
    const profile = tmpDir('dsh-peer-profile-root-')
    const manifest = join(profile, '@deepseek-ai-dsh-api-peer.json')
    writeFileSync(manifest, JSON.stringify({ version: '9.9.9-profile' }))
    expect(resolveCallerHarnessVersion({
      dshHome: home,
      treeManifestPath: join(home, 'missing-package.json'),
      profileManifestPath: manifest,
    })).toBe('9.9.9-profile')
    writeFileSync(manifest, '{ not json')
    expect(() => resolveCallerHarnessVersion({
      dshHome: home,
      treeManifestPath: join(home, 'missing-package.json'),
      profileManifestPath: manifest,
    })).toThrowError(/cannot determine the caller harness version/u)
  })

  it('fails closed naming the env override instead of inventing a version', () => {
    const saved = process.env[CALLER_HARNESS_VERSION_ENV]
    Reflect.deleteProperty(process.env, CALLER_HARNESS_VERSION_ENV)
    try {
      const dir = tmpDir('dsh-peer-version-missing-')
      expect(() => resolveCallerHarnessVersion({
        dshHome: dir,
        profileRoot: dir,
        treeManifestPath: join(dir, 'missing-package.json'),
        profileManifestPath: join(dir, 'missing-peer-package.json'),
      })).toThrowError(new RegExp(`cannot determine the caller harness version.*${CALLER_HARNESS_VERSION_ENV}`, 'u'))
    } finally {
      if (saved !== undefined) process.env[CALLER_HARNESS_VERSION_ENV] = saved
    }
  })
})

describe('LocalPeerClient model control', () => {
  it('handshakes with the resolved version and posts models/selectModel in the same envelope', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return okResponse({ chains: [], models: [], selectableByThisAlias: {}, accepted: true, selected: { provider: 'p', model: 'm' }, replayed: false })
    }) as unknown as typeof fetch
    const client = new LocalPeerClient({ endpoint: 'https://peer.test:8443', device: 'caller', fetch: fetchImpl, harnessVersion: '9.9.9-cli' })
    await client.handshake()
    await client.models({ alias: 'co-dev', participant: { kind: 'peer', name: 'caller' } })
    await client.selectModel({
      target: { kind: 'alias', alias: 'co-dev' },
      participant: { kind: 'peer', name: 'caller' },
      requestId: 'sw-1',
      provider: 'p',
      model: 'm',
    })
    const requestOf = (index: number): Record<string, unknown> => {
      const payload = calls[index]!.body.payload as { args: { request: Record<string, unknown> } }
      return payload.args.request
    }
    expect(requestOf(0).harnessVersion).toBe('9.9.9-cli')
    expect(calls.map(call => call.url)).toEqual([
      'https://peer.test:8443/api/peer/handshake',
      'https://peer.test:8443/api/peer/models',
      'https://peer.test:8443/api/peer/selectModel',
    ])
    expect(requestOf(1)).toEqual({ alias: 'co-dev', participant: { kind: 'peer', name: 'caller' } })
    expect(requestOf(2)).toMatchObject({ requestId: 'sw-1', provider: 'p', model: 'm' })
  })
})

describe('model-control flags', () => {
  it('parses provider/model keeping every slash in the model id', () => {
    expect(parseModelRoute('openrouter/meta/llama-3')).toEqual({ provider: 'openrouter', model: 'meta/llama-3' })
    expect(() => parseModelRoute('no-slash')).toThrowError('expected "provider/model"')
    expect(() => parseModelRoute('/model')).toThrowError('expected "provider/model"')
    expect(() => parseModelRoute('provider/')).toThrowError('expected "provider/model"')
  })

  it('validates the create-only flags and keeps a positive ceiling', () => {
    expect(createRoutingFlags({})).toEqual({})
    expect(createRoutingFlags({ maxTokens: 4096 })).toEqual({ maxTotalTokens: 4096 })
    expect(createRoutingFlags({ model: 'antigravity/gemini', chain: 'free', effort: 'high', maxTokens: 10 })).toEqual({
      provider: 'antigravity', model: 'gemini', chain: 'free', reasoningEffort: 'high', maxTotalTokens: 10,
    })
    expect(() => createRoutingFlags({ maxTokens: 0 })).toThrowError('--max-tokens must be a positive integer')
    expect(() => createRoutingFlags({ maxTokens: Number.NaN })).toThrowError('--max-tokens must be a positive integer')
    expect(() => createRoutingFlags({ chain: '' })).toThrowError('--chain needs a non-empty chain id')
    expect(() => createRoutingFlags({ effort: '' })).toThrowError('--effort needs a non-empty effort')
  })

  it('parses --cursor, --limit, --zero-price, --tools, --chain, --effort, --request-id, --model and --max-tokens', () => {
    const { flags } = parseArgs([
      'models', 'co-dev', '--cursor', 'c1', '--limit', '7', '--zero-price', '--tools',
      '--chain', 'free', '--effort', 'high', '--request-id', 'sw-1', '--model', 'p/m', '--max-tokens', '99',
    ])
    expect(flags).toMatchObject({
      cursor: 'c1', limit: 7, zeroPrice: true, tools: true, chain: 'free', effort: 'high',
      requestId: 'sw-1', model: 'p/m', maxTokens: 99,
    })
  })
})

const MODELS_VALUE = {
  chains: [{ id: 'free', dynamic: true, members: [
    { provider: 'antigravity', model: 'a', state: 'ready' },
    { provider: 'antigravity', model: 'b', state: 'cooldown', cooldownUntil: 1_700_000_000_000 },
    { provider: 'antigravity', model: 'c', state: 'deprecated' },
  ] }],
  models: [{ provider: 'antigravity', model: 'a', tools: true, vision: 'unknown', zeroPrice: true, gated: false, trainsOnData: 'no', reasoningEfforts: ['high'] }],
  nextCursor: 'more',
  selectableByThisAlias: {
    chains: ['free'], models: ['antigravity/*'], reasoningEfforts: ['high'],
    requireZeroPrice: true, requireNoTraining: false, requireTools: false, allowSwitch: 'idle-only',
  },
}

const SWITCH_VALUE = {
  accepted: true,
  selected: { provider: 'antigravity', model: 'switched', chain: 'free', reasoningEffort: 'high' },
  previous: { provider: 'antigravity', model: 'old' },
  replayed: false,
}

function modelClient(
  capabilities: readonly string[],
  calls: Array<{ method: string; request: Record<string, unknown> }>,
  overrides: Record<string, unknown> = {},
) {
  return {
    handshake: async () => ({ protocolVersion: 1, harnessVersion: 'host-1', schemaDigest: '', hostDevice: 'host', capabilities, pairings: [] }),
    models: async (request: Record<string, unknown>) => { calls.push({ method: 'models', request }); return MODELS_VALUE },
    selectModel: async (request: Record<string, unknown>) => { calls.push({ method: 'selectModel', request }); return overrides.selectModel ?? SWITCH_VALUE },
  }
}

describe('commandModels', () => {
  it('refuses a host that does not advertise model discovery with a clear message', async () => {
    const calls: Array<{ method: string; request: Record<string, unknown> }> = []
    const { flags, positional } = commandArgs(['models', 'co-dev'], pairingFile())
    const result = await commandModels(flags, positional, { clientFactory: () => modelClient(['state-latch'], calls) }) as Record<string, unknown>
    expect(result.ok).toBe(false)
    expect(result.error).toMatchObject({ code: 'peer/capability-missing', message: 'host does not advertise model-discovery; upgrade the host' })
    expect(calls).toEqual([])
  })

  it('forwards the filter, cursor, and page limit and returns the policy echo', async () => {
    const calls: Array<{ method: string; request: Record<string, unknown> }> = []
    const { flags, positional } = commandArgs(['models', 'co-dev', '--cursor', 'c1', '--limit', '7', '--zero-price', '--tools'], pairingFile())
    const result = await commandModels(flags, positional, { clientFactory: () => modelClient(['model-discovery'], calls) }) as Record<string, unknown>
    expect(result).toMatchObject({ ok: true, alias: 'co-dev', nextCursor: 'more' })
    expect(calls[0]).toEqual({
      method: 'models',
      request: {
        alias: 'co-dev',
        participant: { kind: 'peer', name: 'caller', device: 'caller' },
        cursor: 'c1',
        limit: 7,
        filter: { zeroPrice: true, tools: true },
      },
    })
  })

  it('rejects a non-positive page limit instead of clamping silently', async () => {
    const { flags, positional } = commandArgs(['models', 'co-dev', '--limit', '0'], pairingFile())
    await expect(commandModels(flags, positional, { clientFactory: () => modelClient(['model-discovery'], []) }))
      .rejects.toThrowError('--limit must be a positive integer')
  })
})

describe('commandSwitch', () => {
  it('refuses a host that does not advertise model switching with a clear message', async () => {
    const calls: Array<{ method: string; request: Record<string, unknown> }> = []
    const { flags, positional } = commandArgs(['switch', 'co-dev', 'antigravity/x'], pairingFile())
    const result = await commandSwitch(flags, positional, { clientFactory: () => modelClient(['model-discovery'], calls) }) as Record<string, unknown>
    expect(result.ok).toBe(false)
    expect(result.error).toMatchObject({ code: 'peer/capability-missing', message: 'host does not advertise model-switch; upgrade the host' })
    expect(calls).toEqual([])
  })

  it('switches an explicit route with a generated requestId and reports replay/previous', async () => {
    const calls: Array<{ method: string; request: Record<string, unknown> }> = []
    const { flags, positional } = commandArgs(['switch', 'co-dev', 'antigravity/a', '--effort', 'high'], pairingFile())
    const result = await commandSwitch(flags, positional, { clientFactory: () => modelClient(['model-switch'], calls) }) as Record<string, unknown>
    expect(result).toMatchObject({ ok: true, replayed: false, selected: SWITCH_VALUE.selected })
    expect(String(result.requestId)).toMatch(/^peer-cli-/u)
    expect(calls[0]!.request).toMatchObject({
      target: { kind: 'alias', alias: 'co-dev' },
      participant: { kind: 'peer', name: 'caller', device: 'caller' },
      requestId: result.requestId,
      provider: 'antigravity',
      model: 'a',
      reasoningEffort: 'high',
    })
  })

  it('switches by chain and reuses an explicit requestId', async () => {
    const calls: Array<{ method: string; request: Record<string, unknown> }> = []
    const { flags, positional } = commandArgs(['switch', 'co-dev', '--chain', 'free', '--request-id', 'sw-1'], pairingFile())
    await commandSwitch(flags, positional, { clientFactory: () => modelClient(['model-switch'], calls) })
    expect(calls[0]!.request).toMatchObject({ requestId: 'sw-1', provider: '', model: '', chain: 'free' })
  })

  it('surfaces the host refusal reason verbatim', async () => {
    const failure = Object.assign(new Error('routing policy refused the requested model (model-not-allowed)'), { code: 'peer/forbidden', endpoint: 'https://peer.test:8443' })
    const client = {
      handshake: async () => ({ protocolVersion: 1, harnessVersion: 'h', schemaDigest: '', hostDevice: 'host', capabilities: ['model-switch'], pairings: [] }),
      selectModel: async () => { throw failure },
    }
    const { flags, positional } = commandArgs(['switch', 'co-dev', 'antigravity/x'], pairingFile())
    await expect(commandSwitch(flags, positional, { clientFactory: () => client }))
      .rejects.toThrowError('routing policy refused the requested model (model-not-allowed)')
  })

  it('requires a route or a chain and a valid provider/model positional', async () => {
    const { flags, positional } = commandArgs(['switch', 'co-dev'], pairingFile())
    await expect(commandSwitch(flags, positional, { clientFactory: () => modelClient(['model-switch'], []) }))
      .rejects.toThrowError('switch needs <alias> and either <provider/model> or --chain <id>')
    const invalid = commandArgs(['switch', 'co-dev', 'no-slash'], pairingFile())
    await expect(commandSwitch(invalid.flags, invalid.positional, { clientFactory: () => modelClient(['model-switch'], []) }))
      .rejects.toThrowError('expected "provider/model"')
    const blankChain = commandArgs(['switch', 'co-dev', '--chain', ''], pairingFile())
    await expect(commandSwitch(blankChain.flags, blankChain.positional, { clientFactory: () => modelClient(['model-switch'], []) }))
      .rejects.toThrowError('--chain needs a non-empty chain id')
  })
})

describe('commandAsk create routing', () => {
  const ROUTED_DOC = [
    'version: 1',
    'device: caller',
    'pairings:',
    '  - alias: co-dev',
    '    peer: serverlocal',
    '    exposure: debug',
    '    endpoint: https://peer.test:8443',
    '    create:',
    '      cwd: /work/scratch',
    '      provider: antigravity',
    '      model: gemini-x',
    '      chain: loopback',
    '      reasoningEffort: low',
    '',
  ].join('\n')

  function createHarness(): { calls: Array<{ method: string; request: Record<string, unknown> }>; client: Record<string, unknown> } {
    const calls: Array<{ method: string; request: Record<string, unknown> }> = []
    let bound = false
    const client: Record<string, unknown> = {
      handshake: async () => ({ protocolVersion: 1, harnessVersion: '0.1.6-alpha.2', schemaDigest: '', hostDevice: 'serverlocal', capabilities: [], pairings: [] }),
      state: async () => {
        if (!bound) {
          const error = Object.assign(new Error('no session bound'), { code: 'peer/not-paired', endpoint: 'https://peer.test:8443' })
          throw error
        }
        return {
          target: { device: 'serverlocal', sessionId: 'sess-1', exposure: 'debug', alias: 'co-dev' },
          state: { latch: 'idle', since: 0, source: 'host-latch', activeDescendants: 0, descendantsExact: true, pendingAsks: [], lastTurnEnd: { turn: 0, reason: 'completed', at: 0 } },
          cursor: 0,
        }
      },
      create: async (request: Record<string, unknown>) => { calls.push({ method: 'create', request }); bound = true; return { created: true } },
      prompt: async (request: Record<string, unknown>) => { calls.push({ method: 'prompt', request }); return { accepted: true, queued: true, hopCount: 1 } },
      follow: async function* (): AsyncGenerator<unknown> {
        yield {
          type: 'snapshot',
          cursor: 4,
          state: { latch: 'idle', since: 0, source: 'host-latch', activeDescendants: 0, descendantsExact: true, pendingAsks: [] },
          records: [
            { seq: 3, time: 1, type: 'turn/start', data: { turn: 1 } },
            { seq: 4, time: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
          ],
        }
      },
    }
    return { calls, client }
  }

  function routedPairingFile(doc = ROUTED_DOC): string {
    const dir = tmpDir('dsh-peer-routed-')
    const path = join(dir, 'pairings.yaml')
    writeFileSync(path, doc)
    return path
  }

  it('forwards --model/--chain/--effort/--max-tokens on the create call', async () => {
    const harness = createHarness()
    const { flags, positional } = commandArgs(['ask', 'co-dev', 'hello', '--chain', 'free', '--effort', 'high', '--max-tokens', '5000'], routedPairingFile())
    const result = await commandAsk(flags, positional, { clientFactory: () => harness.client }) as Record<string, unknown>
    expect(result).toMatchObject({ created: true })
    expect(harness.calls.find(call => call.method === 'create')!.request).toMatchObject({
      alias: 'co-dev',
      cwd: '/work/scratch',
      chain: 'free',
      reasoningEffort: 'high',
      maxTotalTokens: 5000,
    })
    // --chain replaced the pairing route instead of merging with it.
    expect(harness.calls.find(call => call.method === 'create')!.request).not.toHaveProperty('provider')
  })

  it('forwards the pairing create route when no route flag overrides it', async () => {
    const harness = createHarness()
    const { flags, positional } = commandArgs(['ask', 'co-dev', 'hello'], routedPairingFile())
    await commandAsk(flags, positional, { clientFactory: () => harness.client })
    expect(harness.calls.find(call => call.method === 'create')!.request).toMatchObject({
      provider: 'antigravity', model: 'gemini-x', chain: 'loopback', reasoningEffort: 'low',
    })
  })

  it('refuses a create-only flag on an already bound session and points at switch', async () => {
    const harness = createHarness()
    const path = routedPairingFile()
    const { flags, positional } = commandArgs(['ask', 'co-dev', 'hello', '--chain', 'free'], path)
    // Bind the alias first with a plain ask (no route flags), then retry with one.
    await commandAsk(commandArgs(['ask', 'co-dev', 'hello'], path).flags, positional, { clientFactory: () => harness.client })
    await expect(commandAsk(flags, positional, { clientFactory: () => harness.client }))
      .rejects.toThrowError('use `switch` to change its model')
  })
})
