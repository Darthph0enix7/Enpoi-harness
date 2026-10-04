/**
 * Table-driven fold tests for the livingBrief projection unit.
 * Covers: phase transitions, filesTouched, blockers, prose field ownership
 * (I2), goal precedence (I3), same-reference discipline, and the fold
 * fail-safe (doc 34 I2/I3, doc 35 §12.4).
 */
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { fold, view } from '../src/index.ts'
import type { LivingBriefState } from 'dsh-enpoi-contracts'

const ctx = { logger: { warn: () => {} } } as never

function init(): LivingBriefState {
  return {
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
  }
}

function ev(partial: Partial<SessionEvent> & { type: string }): SessionEvent {
  return { seq: 1, time: Date.now(), data: {}, ...partial } as SessionEvent
}

describe('livingBrief fold — phase', () => {
  it('turn/start → working', () => {
    const s = fold(ctx, init(), ev({ type: 'turn/start', data: { turn: 1 } }))
    expect(s.phase).toBe('working')
    expect(s.lastEventSeq).toBe(1)
  })

  it('turn/end completed → idle', () => {
    const s = fold(ctx, init(), ev({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }))
    expect(s.phase).toBe('idle')
  })

  it('turn/end aborted → aborted', () => {
    const s = fold(ctx, init(), ev({ type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } }))
    expect(s.phase).toBe('aborted')
  })
})

describe('livingBrief fold — filesTouched', () => {
  it('write tool with file_path → filesTouched', () => {
    const s = fold(ctx, init(), ev({
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({ file_path: 'src/a.ts', content: 'x' }) },
    }))
    expect(s.filesTouched).toEqual(['src/a.ts'])
  })

  it('edit tool → filesTouched, deduped', () => {
    let s = fold(ctx, init(), ev({
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'c1', name: 'edit', arguments: JSON.stringify({ file_path: 'src/a.ts' }) },
    }))
    s = fold(ctx, s, ev({
      type: 'tool/call',
      data: { turn: 1, step: 2, callId: 'c2', name: 'edit', arguments: JSON.stringify({ file_path: 'src/a.ts' }) },
    }))
    expect(s.filesTouched).toEqual(['src/a.ts'])
  })

  it('read tool → no filesTouched', () => {
    const s = fold(ctx, init(), ev({
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'src/a.ts' }) },
    }))
    expect(s.filesTouched).toEqual([])
  })

  it('malformed arguments JSON → no crash, no filesTouched', () => {
    const s = fold(ctx, init(), ev({
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: '{not json' },
    }))
    expect(s.filesTouched).toEqual([])
    expect(s.foldErrors).toBe(0)
  })
})

describe('livingBrief fold — blockers', () => {
  it('tool/result with error → blocker with tool name (message source carries the call id)', () => {
    let s = fold(ctx, init(), ev({
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' },
    }))
    s = fold(ctx, s, ev({
      type: 'tool/result',
      data: {
        turn: 1, step: 1,
        message: { source: { kind: 'tool', callId: 'c1' }, role: 'tool', content: [] },
        error: { name: 'EACCES', code: 'EACCES' },
      },
    }))
    expect(s.blockers).toHaveLength(1)
    expect(s.blockers[0].tool).toBe('bash')
    expect(s.blockers[0].text).toContain('EACCES')
  })

  it('tool/result with a flat call id still attributes the tool', () => {
    let s = fold(ctx, init(), ev({
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'c9', name: 'glob', arguments: '{}' },
    }))
    s = fold(ctx, s, ev({
      type: 'tool/result',
      data: { turn: 1, step: 1, callId: 'c9', message: {}, error: { name: 'SearchError', code: 'SEARCH_FAILED' } },
    }))
    expect(s.blockers[0].tool).toBe('glob')
  })

  it('tool/result whose call id matches no recorded call → blocker without a tool', () => {
    const s = fold(ctx, init(), ev({
      type: 'tool/result',
      data: { turn: 1, step: 1, message: { source: { callId: 'missing' } }, error: { name: 'X', code: 'Y' } },
    }))
    expect(s.blockers).toHaveLength(1)
    expect(s.blockers[0].tool).toBeUndefined()
  })

  it('tool/result without error → no blocker', () => {
    let s = fold(ctx, init(), ev({
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' },
    }))
    s = fold(ctx, s, ev({
      type: 'tool/result',
      data: { turn: 1, step: 1, callId: 'c1', message: {} },
    }))
    expect(s.blockers).toHaveLength(0)
  })
})

describe('livingBrief fold — prose (I2 field ownership)', () => {
  it('keeper prose → prose set + goal/decisions/openThreads + structural metadata', () => {
    const s = fold(ctx, init(), ev({
      type: 'brief/prose-updated',
      data: {
        goal: 'Build the orchestrator',
        decisions: ['Use spawn not fork'],
        openThreads: ['Keeper model choice'],
        basedOnSeq: 5,
        basedOnStructuralCount: 4,
        structuralDistanceK: 24,
        model: 'deepseek/deepseek-v4-flash',
        text: '- goal: build orchestrator\n- decided: spawn',
        origin: 'context-keeper',
      },
    }))
    expect(s.prose?.text).toContain('build orchestrator')
    expect(s.prose?.basedOnSeq).toBe(5)
    expect(s.prose?.basedOnStructuralCount).toBe(4)
    expect(s.prose?.structuralDistanceK).toBe(24)
    expect(s.goal).toBe('Build the orchestrator')
    expect(s.decisions).toHaveLength(1)
    expect(s.openThreads).toHaveLength(1)
  })

  it('non-keeper origin → prose fields ignored (I2)', () => {
    const s = fold(ctx, init(), ev({
      type: 'brief/prose-updated',
      data: { goal: 'EVIL', basedOnSeq: 0, basedOnStructuralCount: 0, model: 'x', text: 'x', origin: 'attacker' },
    }))
    expect(s.prose).toBeNull()
    expect(s.goal).toBe('')
  })

  it('I3: prose based on stale seq cannot touch goal', () => {
    const base = { ...init(), goalSeq: 10 }
    const s = fold(ctx, base, ev({
      type: 'brief/prose-updated',
      data: { goal: 'STALE GOAL', basedOnSeq: 5, basedOnStructuralCount: 4, model: 'm', text: 't', origin: 'context-keeper' },
    }))
    expect(s.goal).toBe('') // goal untouched
    expect(s.prose?.text).toBe('t') // prose still updated
  })

  it('I3: prose based on fresh seq CAN touch goal', () => {
    const base = { ...init(), goalSeq: 10 }
    const s = fold(ctx, base, ev({
      type: 'brief/prose-updated',
      data: { goal: 'FRESH GOAL', basedOnSeq: 12, basedOnStructuralCount: 11, model: 'm', text: 't', origin: 'context-keeper' },
    }))
    expect(s.goal).toBe('FRESH GOAL')
  })
})

describe('livingBrief fold — discipline', () => {
  it('uninterested event returns the SAME reference (Object.is)', () => {
    const s = init()
    const next = fold(ctx, s, ev({ type: 'request/header', data: { header: {}, reason: 'first' } }))
    expect(next).toBe(s)
  })

  it('fail-safe: malformed event → foldErrors++, state intact', () => {
    const s = init()
    const next = fold(ctx, s, ev({ type: 'turn/end', data: null }))
    expect(next.foldErrors).toBe(1)
    expect(next.phase).toBe('idle')
    expect(next.lastEventSeq).toBe(1)
  })
})

describe('livingBrief view — seq-based freshness (Oracle amendment 4)', () => {
  it('freshness: no prose → stale', () => {
    const v = view(init())
    expect(v.freshness).toBe('stale')
    expect(v.asOfSeq).toBe(0)
  })

  it('freshness: structural distance within K → live (silence never invalidates)', () => {
    const s = {
      ...init(),
      prose: { text: 't', updatedAt: Date.now() - 600_000, model: 'm', basedOnSeq: 5, basedOnStructuralCount: 4, structuralDistanceK: 24 },
      structuralCount: 10, // 6 structural events since the prose — within K
      lastEventSeq: 7,
    }
    const v = view(s)
    expect(v.freshness).toBe('live')
    expect(v.asOfSeq).toBe(7)
  })

  it('freshness: structural distance beyond 2K → stale (even if wall-clock is young)', () => {
    const s = {
      ...init(),
      prose: { text: 't', updatedAt: Date.now(), model: 'm', basedOnSeq: 5, basedOnStructuralCount: 4, structuralDistanceK: 24 },
      structuralCount: 60, // 56 structural events since the prose — far beyond 2K
    }
    expect(view(s).freshness).toBe('stale')
  })

  it('freshness: distance between K and 2K → cooling', () => {
    const s = {
      ...init(),
      prose: { text: 't', updatedAt: Date.now(), model: 'm', basedOnSeq: 5, basedOnStructuralCount: 4, structuralDistanceK: 24 },
      structuralCount: 40, // 36 structural events — between K and 2K
    }
    expect(view(s).freshness).toBe('cooling')
  })
})

describe('livingBrief fold — structuralCount', () => {
  it('counts only structural events (user/message, turn/end, tool/call, tool/result)', () => {
    let s = init()
    s = fold(ctx, s, ev({ type: 'user/message', data: { content: 'hi' } }))
    s = fold(ctx, s, ev({ type: 'assistant/message', data: { text: 'yo' } }))
    s = fold(ctx, s, ev({ type: 'turn/end', data: { reason: { kind: 'completed' } } }))
    s = fold(ctx, s, ev({ type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: '{}' } }))
    s = fold(ctx, s, ev({ type: 'tool/result', data: { callId: 'c1', message: {} } }))
    s = fold(ctx, s, ev({ type: 'request/header', data: { header: {}, reason: 'x' } }))
    expect(s.structuralCount).toBe(4) // user/message + turn/end + tool/call + tool/result
  })
})