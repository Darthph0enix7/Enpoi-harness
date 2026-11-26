import { describe, expect, it } from 'vitest'
import { derivePromptDisposition } from '../src/disposition.ts'
import type { PeerFoldEvent } from '../src/latch.ts'
import { PEER_BUDGET_STOP_REASON } from '../src/latch.ts'

function msg(id: string, rpcId?: string): Record<string, unknown> {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text: `prompt-${id}` }],
    source: rpcId === undefined
      ? { kind: 'user' }
      : { kind: 'user', rpcId, participant: { kind: 'peer', name: 'laptop', device: 'laptop' } },
  }
}

function event(seq: number, type: string, data: unknown): PeerFoldEvent {
  return { seq, time: 1000 + seq * 10, type, data }
}

describe('derivePromptDisposition', () => {
  it.each<{
    readonly name: string
    readonly requestId: string
    readonly events: readonly PeerFoldEvent[]
    readonly expected: ReturnType<typeof derivePromptDisposition>
  }>([
    {
      name: 'unknown when log has no matching rpcId',
      requestId: 'req-missing',
      events: [
        event(0, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [msg('m1', 'req-other')] }),
      ],
      expected: { disposition: 'unknown' },
    },
    {
      name: 'queued when inserted in next-turn and not yet claimed',
      requestId: 'req-1',
      events: [
        event(0, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [msg('m1', 'req-1')] }),
      ],
      expected: { disposition: 'queued' },
    },
    {
      name: 'queued when a prior queued item is claimed while target remains at index 0',
      requestId: 'req-2',
      events: [
        event(0, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [msg('m1', 'req-1')] }),
        event(1, 'agent/inbox/spliced', { target: 'next-turn', start: 1, inserted: [msg('m2', 'req-2')] }),
        event(2, 'turn/start', { turn: 1 }),
        event(3, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
        event(4, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user', intent: 'detach' } } }),
      ],
      expected: { disposition: 'queued' },
    },
    {
      name: 'queued when moved via steer (remove with outcome canceled then insert into next-step)',
      requestId: 'req-steer',
      events: [
        event(0, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [msg('m1', 'req-steer')] }),
        event(1, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }),
        event(2, 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [msg('m1', 'req-steer')] }),
      ],
      expected: { disposition: 'queued' },
    },
    {
      name: 'queued when replaced in place via queue edit',
      requestId: 'req-edit',
      events: [
        event(0, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [msg('m1', 'req-edit')] }),
        event(1, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [msg('m1', 'req-edit')], outcome: 'canceled' }),
      ],
      expected: { disposition: 'queued' },
    },
    {
      name: 'claimed when spliced out without canceled inside an open turn',
      requestId: 'req-claimed',
      events: [
        event(0, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [msg('m1', 'req-claimed')] }),
        event(1, 'turn/start', { turn: 1 }),
        event(2, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
        event(3, 'step/start', { turn: 1, step: 1 }),
        event(4, 'user/message', msg('m1', 'req-claimed')),
      ],
      expected: { disposition: 'claimed' },
    },
    {
      name: 'cancelled_before_dispatch when removed with outcome canceled while queued',
      requestId: 'req-cancel',
      events: [
        event(0, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [msg('m1', 'req-other')] }),
        event(1, 'agent/inbox/spliced', { target: 'next-turn', start: 1, inserted: [msg('m2', 'req-cancel')] }),
        event(2, 'agent/inbox/spliced', { target: 'next-turn', start: 1, removedCount: 1, inserted: [], outcome: 'canceled' }),
      ],
      expected: { disposition: 'cancelled_before_dispatch' },
    },
    {
      name: 'terminal completed once consuming turn ends',
      requestId: 'req-done',
      events: [
        event(0, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [msg('m1', 'req-done')] }),
        event(1, 'turn/start', { turn: 1 }),
        event(2, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
        event(3, 'step/start', { turn: 1, step: 1 }),
        event(4, 'user/message', msg('m1', 'req-done')),
        event(5, 'step/end', { turn: 1, step: 1 }),
        event(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ],
      expected: {
        disposition: 'terminal',
        terminalState: 'completed',
        terminal: { turn: 1, reason: 'completed', at: 1060 },
      },
    },
    {
      name: 'terminal aborted on user cancel',
      requestId: 'req-abort',
      events: [
        event(0, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [msg('m1', 'req-abort')] }),
        event(1, 'turn/start', { turn: 2 }),
        event(2, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
        event(3, 'turn/end', {
          turn: 2,
          reason: { kind: 'aborted', reason: { kind: 'user', intent: 'stop-all' } },
        }),
      ],
      expected: {
        disposition: 'terminal',
        terminalState: 'aborted',
        terminal: { turn: 2, reason: 'aborted', at: 1030 },
      },
    },
    {
      name: 'terminal budget when aborted by peer budget hook',
      requestId: 'req-budget',
      events: [
        event(0, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [msg('m1', 'req-budget')] }),
        event(1, 'turn/start', { turn: 3 }),
        event(2, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
        event(3, 'turn/end', {
          turn: 3,
          reason: { kind: 'aborted', reason: { kind: 'hook', reason: PEER_BUDGET_STOP_REASON } },
        }),
      ],
      expected: {
        disposition: 'terminal',
        terminalState: 'budget',
        terminal: { turn: 3, reason: 'aborted', at: 1030, stop: 'budget' },
      },
    },
    {
      name: 'terminal failed when turn ends with error',
      requestId: 'req-err',
      events: [
        event(0, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [msg('m1', 'req-err')] }),
        event(1, 'turn/start', { turn: 4 }),
        event(2, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
        event(3, 'turn/end', {
          turn: 4,
          reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: 'slow down', provider: 'p', model: 'm' } },
        }),
      ],
      expected: {
        disposition: 'terminal',
        terminalState: 'failed',
        terminal: {
          turn: 4,
          reason: 'error',
          at: 1030,
          error: { code: 'RATE_LIMIT', message: 'slow down', provider: 'p', model: 'm' },
        },
      },
    },
    {
      name: 'terminal blocked when pre-step rejects claimed input',
      requestId: 'req-blocked',
      events: [
        event(0, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [msg('m1', 'req-blocked')] }),
        event(1, 'turn/start', { turn: 5 }),
        event(2, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
        event(3, 'turn/end', { turn: 5, reason: { kind: 'blocked' } }),
      ],
      expected: {
        disposition: 'terminal',
        terminalState: 'blocked',
        terminal: { turn: 5, reason: 'blocked', at: 1030 },
      },
    },
    {
      name: 'unknown when splice history has invalid coordinates',
      requestId: 'req-bad',
      events: [
        event(0, 'agent/inbox/spliced', { target: 'next-turn', start: 4, removedCount: 1, inserted: [] }),
      ],
      expected: { disposition: 'unknown' },
    },
    {
      name: 'unknown when splice data is non-object, bad target, bad removedCount, or non-array inserted',
      requestId: 'req-bad-shapes',
      events: [
        event(0, 'agent/inbox/spliced', null),
      ],
      expected: { disposition: 'unknown' },
    },
    {
      name: 'unknown when splice target is invalid',
      requestId: 'req-bad-target',
      events: [
        event(0, 'agent/inbox/spliced', { target: 'other', start: 0, inserted: [] }),
      ],
      expected: { disposition: 'unknown' },
    },
    {
      name: 'unknown when splice removedCount is negative or exceeds inbox length',
      requestId: 'req-bad-removed',
      events: [
        event(0, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 2, inserted: [] }),
      ],
      expected: { disposition: 'unknown' },
    },
    {
      name: 'unknown when splice inserted is not an array',
      requestId: 'req-bad-inserted',
      events: [
        event(0, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: 'oops' }),
      ],
      expected: { disposition: 'unknown' },
    },
    {
      name: 'claimed from direct user/message inside an open turn',
      requestId: 'req-direct-user',
      events: [
        event(0, 'turn/start', { turn: 1 }),
        event(1, 'user/message', msg('m1', 'req-direct-user')),
      ],
      expected: { disposition: 'claimed' },
    },
    {
      name: 'terminal max-tokens when turn hit output ceiling',
      requestId: 'req-max-tokens',
      events: [
        event(0, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [msg('m1', 'req-max-tokens')] }),
        event(1, 'turn/start', { turn: 6 }),
        event(2, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
        event(3, 'turn/end', { turn: 6, reason: { kind: 'max-tokens' } }),
      ],
      expected: {
        disposition: 'terminal',
        terminalState: 'max-tokens',
        terminal: { turn: 6, reason: 'max-tokens', at: 1030 },
      },
    },
    {
      name: 'terminal interrupted when crash-orphaned turn closed on resume',
      requestId: 'req-interrupted',
      events: [
        event(0, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [msg('m1', 'req-interrupted')] }),
        event(1, 'turn/start', { turn: 7 }),
        event(2, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
        event(3, 'turn/end', { turn: 7, reason: { kind: 'interrupted' } }),
      ],
      expected: {
        disposition: 'terminal',
        terminalState: 'interrupted',
        terminal: { turn: 7, reason: 'interrupted', at: 1030 },
      },
    },
    {
      name: 'terminal maps unknown merge-extensible turn end reason to failed',
      requestId: 'req-custom-end',
      events: [
        event(0, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [msg('m1', 'req-custom-end')] }),
        event(1, 'turn/start', { turn: 8 }),
        event(2, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
        event(3, 'turn/end', { turn: 8, reason: { kind: 'vendor-halt' } }),
      ],
      expected: {
        disposition: 'terminal',
        terminalState: 'failed',
        terminal: { turn: 8, reason: 'vendor-halt' as never, at: 1030 },
      },
    },
  ])('$name', ({ requestId, events, expected }) => {
    expect(derivePromptDisposition(events, requestId)).toEqual(expected)
  })
})
