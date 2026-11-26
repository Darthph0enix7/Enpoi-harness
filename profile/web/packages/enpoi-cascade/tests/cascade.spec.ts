import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import { apply } from '../src/index.ts'

/**
 * Intent-aware stop cascade specs (doc 79a): detach never walks descendants;
 * stop-all keeps the full cascade; revert parks only the reverted span's
 * subtrees; an absent intent keeps the pre-intent stop-all behaviour.
 */

const PARENT = 'parent-session' as SessionId

const originalHome = process.env.DSH_HOME
let logRoot: string | undefined

beforeAll(() => {
  // Diagnostics must never touch the live ~/.dsh log this profile writes.
  logRoot = mkdtempSync(join(tmpdir(), 'enpoi-cascade-spec-'))
  process.env.DSH_HOME = logRoot
})

afterAll(() => {
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  if (logRoot !== undefined) rmSync(logRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function child(
  id: string,
  parentId: string,
  depth: number,
  seq: number,
  mode: 'continuable' | 'one-shot' = 'continuable',
): SubagentDescendantListEntry {
  return {
    kind: 'child',
    id: id as SessionId,
    seq: seq as never,
    mode,
    label: id,
    activity: 'running',
    hasChildren: false,
    parentId: parentId as SessionId,
    depth,
  }
}

interface Bench {
  interrupt: ReturnType<typeof vi.fn>
  listDescendants: ReturnType<typeof vi.fn>
  stop: (cause: Record<string, unknown>) => Promise<void>
  stopAll: (window?: symbol) => void
}

function bench(entries: SubagentDescendantListEntry[]): Bench {
  const interrupt = vi.fn()
  const listDescendants = vi.fn(async () => entries)
  const session = { id: PARENT }
  const agent = { id: PARENT, session }
  const sessionListeners: Array<(session: { id: SessionId }, event: SessionEvent) => void> = []
  const stopAllListeners: Array<(parent: typeof agent, window: symbol) => void> = []
  const ctx = {
    on: (...args: ['session/event', typeof sessionListeners[number]] | ['subagent/stop-all', typeof stopAllListeners[number]]) => {
      if (args[0] === 'session/event') sessionListeners.push(args[1])
      else stopAllListeners.push(args[1])
    },
    get: (name: string) => name === 'subagents'
      ? { listDescendants, interrupt }
      : name === 'agents' ? { get: () => agent } : undefined,
    logger: { warn: vi.fn() },
  } as unknown as Context
  apply(ctx)
  const stop = async (cause: Record<string, unknown>): Promise<void> => {
    const event = {
      type: 'turn/end',
      data: { reason: { kind: 'aborted', reason: { kind: 'user', ...cause } } },
    } as unknown as SessionEvent
    for (const listener of sessionListeners) listener(session, event)
    await vi.runAllTimersAsync()
  }
  const stopAll = (window = Symbol()): void => {
    for (const listener of stopAllListeners) listener(agent, window)
  }
  return { interrupt, listDescendants, stop, stopAll }
}

describe('enpoi-cascade stop intents', () => {
  it('detach abandons only the turn: no enumeration and no interrupts', async () => {
    vi.useFakeTimers()
    try {
      const b = bench([child('a', PARENT, 1, 10)])
      await b.stop({ intent: 'detach' })
      expect(b.listDescendants).not.toHaveBeenCalled()
      expect(b.interrupt).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop-all interrupts every live continuable descendant and skips non-continuables', async () => {
    vi.useFakeTimers()
    try {
      const b = bench([
        child('a', PARENT, 1, 10),
        child('once', PARENT, 1, 11, 'one-shot'),
        { kind: 'diagnostic', id: 'broken' as SessionId, parentId: PARENT, depth: 1, reason: 'unavailable' },
      ])
      b.stopAll()
      await vi.runAllTimersAsync()
      expect(b.interrupt).toHaveBeenCalledTimes(1)
      expect(b.interrupt).toHaveBeenCalledWith('a', { kind: 'ancestor', agent: expect.objectContaining({ id: PARENT }) })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not cascade directly from a durable Stop-all in addition to the runtime signal', async () => {
    vi.useFakeTimers()
    try {
      const b = bench([child('a', PARENT, 1, 10), child('b', PARENT, 1, 11)])
      b.stopAll()
      await b.stop({ intent: 'stop-all' })
      await b.stop({})
      expect(b.listDescendants).toHaveBeenCalledTimes(1)
      expect(b.interrupt).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('coalesces repeat presses without dropping a Stop-all after a new turn', async () => {
    vi.useFakeTimers()
    const firstRead = Promise.withResolvers<SubagentDescendantListEntry[]>()
    try {
      const b = bench([child('a', PARENT, 1, 10)])
      b.listDescendants.mockReturnValueOnce(firstRead.promise)
      const window = Symbol()
      b.stopAll(window)
      b.stopAll(window)
      await vi.runAllTimersAsync()
      expect(b.listDescendants).toHaveBeenCalledTimes(1)

      b.stopAll()
      await vi.runAllTimersAsync()
      expect(b.listDescendants).toHaveBeenCalledTimes(2)
      expect(b.interrupt).toHaveBeenCalledTimes(1)
    } finally {
      firstRead.resolve([])
      await vi.runAllTimersAsync()
      vi.useRealTimers()
    }
  })

  it('revert parks only direct children spawned after the anchor plus their subtrees', async () => {
    vi.useFakeTimers()
    try {
      const b = bench([
        child('old', PARENT, 1, 10),
        child('new', PARENT, 1, 20),
        child('old-leaf', 'old', 2, 30),
        child('new-leaf', 'new', 2, 40),
        child('newer', PARENT, 1, 21),
      ])
      await b.stop({ intent: 'revert', revertFromSeq: 15 })
      // 'old' (seq 10) survives with its subtree; 'new' (20) and 'newer' (21)
      // are cancelled together with 'new-leaf'.
      expect(b.interrupt.mock.calls.map(([id]) => id).sort()).toEqual(['new', 'new-leaf', 'newer'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('revert without an anchor parks nothing', async () => {
    vi.useFakeTimers()
    try {
      const b = bench([child('a', PARENT, 1, 10)])
      await b.stop({ intent: 'revert' })
      expect(b.interrupt).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
